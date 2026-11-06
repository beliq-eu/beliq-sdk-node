import type { BuiltRequest } from './buildRequest';
import { DEFAULT_MAX_RETRIES } from './constants';
import { errorFromResponse, BeliqApiError } from './errors';

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  auth: 'header' | 'bearer';
  fetchImpl: typeof fetch;
  /** Per-attempt deadline in ms. 0 disables. */
  timeoutMs: number;
  /**
   * The caller's `maxRetries`, undefined when it set none. Unset, only the
   * failures retried by count are bounded, by `DEFAULT_MAX_RETRIES`; set, it
   * bounds every retry.
   */
  maxRetries?: number;
  /** Time from the start of the first attempt after which no attempt starts. */
  retryBudgetMs: number;
  /**
   * Backoff when no `Retry-After` is given: the base doubles per attempt, and no
   * wait reaches the ceiling. Unset, `BACKOFF_BASE_MS` and `BACKOFF_CEILING_MS`;
   * a test sets smaller ones.
   */
  backoffBaseMs?: number;
  backoffCeilingMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

/**
 * The one 429 waiting cannot clear. `RATE_LIMITED` frees up in seconds and
 * `ACCOUNT_THROTTLED` in minutes, but a spent monthly allowance only returns when
 * the billing window turns, and beliq says so honestly: its `Retry-After` on this
 * code is the seconds remaining in the window, which can be weeks. Retrying it
 * waits against a refusal that is already final, so the caller is told the
 * request hung rather than that the quota is gone.
 */
const QUOTA_EXHAUSTED_CODE = 'QUOTA_EXCEEDED';

/** The API's answer while its database is out; the outage it reports outlasts a few quick retries. */
const DATABASE_UNAVAILABLE_CODE = 'DATABASE_UNAVAILABLE';

/**
 * `cause.code` values of a fetch that failed before the request left this host:
 * nothing reached the server, so nothing ran or was charged. `ENETUNREACH` (no
 * route) and `EHOSTUNREACH` (the host does not answer) were measured from a
 * connect. Every other thrown error, `ECONNRESET` and `UND_ERR_SOCKET` included,
 * can happen after the request was sent, so it is retried by count only. So is
 * a TLS failure, whose certificate code is not on the list: no wait fixes it.
 */
const BEFORE_SEND_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * How a failure is retried.
 *
 * `budget`: an outage a wait can outlast, retried until the time budget is spent.
 * A 503 `DATABASE_UNAVAILABLE`, a 502 or 503 with no beliq error code (the edge
 * answered, or the pod that held the connection is gone), and a connection that
 * could not be opened.
 *
 * `count`: retried up to `maxRetries` times. A 429 other than `QUOTA_EXCEEDED`,
 * since each one counts toward the account's throttle; a 502 or 503 with any
 * other beliq code, `ENGINE_UNAVAILABLE` included, since an engine timeout
 * answers that code too and a budget would run the same slow document dozens of
 * times; and a thrown error that may have come after the request was sent.
 *
 * Anything else is not retried. A 504 and this client's own timeout mean the
 * work may still be running on beliq's side, so a retry can produce a second
 * document rather than recover the first.
 */
type RetryClass = 'budget' | 'count';

function classifyStatus(status: number, code?: string): RetryClass | undefined {
  if (status === 429) return code === QUOTA_EXHAUSTED_CODE ? undefined : 'count';
  if (status !== 502 && status !== 503) return undefined;
  if (!code) return 'budget';
  return status === 503 && code === DATABASE_UNAVAILABLE_CODE ? 'budget' : 'count';
}

function classifyThrown(err: unknown): RetryClass {
  const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === 'string' && BEFORE_SEND_CODES.has(code) ? 'budget' : 'count';
}

/** Base for exponential backoff when no `Retry-After` is given. */
const BACKOFF_BASE_MS = 500;

/** No backoff wait reaches this, however many attempts came before. */
const BACKOFF_CEILING_MS = 30_000;

/** Spread added to a server-supplied `Retry-After`. */
const RETRY_AFTER_JITTER_MS = 250;

function authHeaders(config: ResolvedConfig): Record<string, string> {
  return config.auth === 'bearer'
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { 'X-API-Key': config.apiKey };
}

function buildUrl(baseUrl: string, path: string, query?: BuiltRequest['query']): string {
  if (!query) return `${baseUrl}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${baseUrl}${path}?${qs}` : `${baseUrl}${path}`;
}

/**
 * Delay before the next attempt: the server's `Retry-After` in full when it sent
 * one, otherwise exponential backoff. Jittered either way so a fleet of clients
 * that failed together does not return in lockstep. The backoff is held to half
 * the ceiling before its jitter of up to 100%, so no wait reaches the ceiling and
 * clients at the cap still spread out.
 */
function retryDelayMs(
  res: Response | undefined,
  attempt: number,
  config: Pick<ResolvedConfig, 'backoffBaseMs' | 'backoffCeilingMs'>,
): number {
  const header = res?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000 + Math.random() * RETRY_AFTER_JITTER_MS;
    }
  }
  const base = config.backoffBaseMs ?? BACKOFF_BASE_MS;
  const ceiling = config.backoffCeilingMs ?? BACKOFF_CEILING_MS;
  const backoff = Math.min(base * 2 ** attempt, ceiling / 2);
  return backoff + Math.random() * backoff;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Perform the request and return the raw response. Throws BeliqApiError on any
 * non-2xx status (the body is parsed for the `{ success:false, error }`
 * envelope). The caller interprets a 2xx body per the request's outputKind.
 *
 * Retries transient failures automatically (see RetryClass), honouring
 * `Retry-After` in full. No attempt starts after `retryBudgetMs`, so a
 * `Retry-After` longer than the budget left ends the call at once with the error
 * that carried it. A document request can legitimately take tens of seconds,
 * because beliq runs the full Schematron rule set over it, so the per-attempt
 * deadline is generous by default: it exists to stop a call hanging forever, not
 * to bound normal work.
 */
export async function send(config: ResolvedConfig, req: BuiltRequest): Promise<RawResponse> {
  const headers: Record<string, string> = { ...authHeaders(config) };
  if (req.contentType) headers['Content-Type'] = req.contentType;
  if (req.accept) headers['Accept'] = req.accept;

  const body =
    req.jsonBody !== undefined ? JSON.stringify(req.jsonBody) : req.rawBody;
  const url = buildUrl(config.baseUrl, req.path, req.query);

  const started = performance.now();
  let countedRetries = 0;
  for (let attempt = 0; ; attempt++) {
    // A fresh controller per attempt: an aborted signal stays aborted, so
    // reusing one would fail every retry instantly.
    const controller = new AbortController();
    const timer =
      config.timeoutMs > 0
        ? setTimeout(() => controller.abort(), config.timeoutMs)
        : undefined;

    let res: Response | undefined;
    let failure: unknown;
    let retryClass: RetryClass | undefined;
    try {
      res = await config.fetchImpl(url, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      });

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.ok) return { status: res.status, headers: res.headers, bytes };

      const apiError = errorFromResponse(res.status, bytes);
      failure = apiError;
      retryClass = classifyStatus(apiError.status, apiError.code);
    } catch (err) {
      // An abort is this client's own deadline, not a server fault: the request
      // may have been received and be running, so retrying risks a duplicate.
      if (controller.signal.aborted) {
        throw new BeliqApiError(
          `beliq: request to ${req.path} exceeded ${config.timeoutMs}ms`,
          { status: 0, code: 'TIMEOUT' },
        );
      }
      failure = err;
      retryClass = classifyThrown(err);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (retryClass === undefined) throw failure;
    // `attempt` is also the number of retries so far.
    if (config.maxRetries !== undefined) {
      if (attempt >= config.maxRetries) throw failure;
    } else if (retryClass === 'count' && countedRetries >= DEFAULT_MAX_RETRIES) {
      throw failure;
    }
    const delay = retryDelayMs(res, attempt, config);
    if (performance.now() - started + delay > config.retryBudgetMs) throw failure;

    if (retryClass === 'count') countedRetries++;
    await sleep(delay);
  }
}
