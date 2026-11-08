import type { BuiltRequest } from './buildRequest';
import { DEFAULT_MAX_RETRIES } from './constants';
import { errorFromResponse, parseRetryAfterSeconds, BeliqApiError } from './errors';
import type { ApiErrorCode } from './types';

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
const QUOTA_EXHAUSTED_CODE: ApiErrorCode = 'QUOTA_EXCEEDED';

/** The API's answer while its database is out; the outage it reports outlasts a few quick retries. */
// Typed by the generated error union, so a code renamed in openapi.json fails the typecheck.
const DATABASE_UNAVAILABLE_CODE: ApiErrorCode = 'DATABASE_UNAVAILABLE';

/**
 * `cause.code` values of a fetch that failed before the request left this host,
 * so nothing ran or was charged. `ENETUNREACH` (no route) and `EHOSTUNREACH` (the
 * host does not answer) were measured from a connect. On a connection already
 * open, TCP treats both as soft errors (RFC 1122, section 4.2.3.9) and reports
 * one only when its retransmission timeout ends, 924.6 s by Linux's default
 * `tcp_retries2` (tcp(7)), long after the default per-attempt deadline aborts
 * the attempt as a timeout. Every other thrown error, `ECONNRESET` and
 * `UND_ERR_SOCKET` included, can happen after the request was sent, so it is
 * retried by count only, except a certificate failure (see `isCertificateFailure`).
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
 * Node's X509 certificate error codes
 * (https://nodejs.org/api/tls.html#x509-certificate-error-codes), which undici
 * passes on as the `cause.code` of `fetch failed`.
 */
const CERTIFICATE_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'OUT_OF_MEM',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
]);

/**
 * A certificate that fails verification, or one for another name
 * (`ERR_TLS_CERT_ALTNAME_INVALID`). Both come from the handshake, before the
 * request is sent, and no wait fixes them, so they are not retried, as the
 * Python SDK raises them at once. An OpenSSL error (`ERR_SSL_*`) is not among
 * them: it can also end a connection after the request was sent, and nothing
 * in it says which, so it stays retried by count.
 */
function isCertificateFailure(code: string): boolean {
  return CERTIFICATE_ERROR_CODES.has(code) || code === 'ERR_TLS_CERT_ALTNAME_INVALID';
}

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
 * beliq may have run and charged that request, but it does not charge a repeat
 * of a charged request within 15 minutes, up to 10 repeats (beliq's own values,
 * which no standard sets), and every attempt sends the same bytes.
 *
 * `none`: not retried. A 504 and this client's own timeout mean the work may
 * still be running on beliq's side, and a repeat runs the same document again
 * from the start, likely into the same deadline. A certificate failure and
 * every other status are final too.
 */
export type RetryClass = 'budget' | 'count' | 'none';

function classifyStatus(status: number, code?: string): RetryClass {
  if (status === 429) return code === QUOTA_EXHAUSTED_CODE ? 'none' : 'count';
  if (status !== 502 && status !== 503) return 'none';
  if (!code) return 'budget';
  return status === 503 && code === DATABASE_UNAVAILABLE_CODE ? 'budget' : 'count';
}

function classifyThrown(err: unknown): RetryClass {
  const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  if (typeof code !== 'string') return 'count';
  if (isCertificateFailure(code)) return 'none';
  return BEFORE_SEND_CODES.has(code) ? 'budget' : 'count';
}

/**
 * How the client's retry loop treats a failure that a `Beliq` method threw, so
 * a caller that turns the client's retry off can hand the failure to a retry
 * of its own. The loop uses this same function, so its answer is the one the
 * loop acted on: `budget` was retried until `retryBudgetMs` was spent, `count`
 * up to `maxRetries` times, `none` not at all. It reads a `BeliqApiError` by its
 * status and code, `TIMEOUT` (this client's own deadline) as `none`, and any
 * other error by its `cause.code`, as `fetch` throws it. An abort by the
 * caller's own `signal` throws the signal's reason, which the loop never
 * classifies: check the signal's `aborted` before asking this.
 */
export function retryClass(error: unknown): RetryClass {
  // By name as well as by class: an ESM and a CommonJS copy of this package in
  // one process each have their own BeliqApiError.
  if (
    error instanceof BeliqApiError ||
    ((error as { name?: unknown } | undefined)?.name === 'BeliqApiError' &&
      typeof (error as { status?: unknown }).status === 'number')
  ) {
    const apiError = error as BeliqApiError;
    return classifyStatus(apiError.status, apiError.code);
  }
  return classifyThrown(error);
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
  const seconds = parseRetryAfterSeconds(res?.headers);
  if (seconds !== undefined) return seconds * 1000 + Math.random() * RETRY_AFTER_JITTER_MS;
  const base = config.backoffBaseMs ?? BACKOFF_BASE_MS;
  const ceiling = config.backoffCeilingMs ?? BACKOFF_CEILING_MS;
  const backoff = Math.min(base * 2 ** attempt, ceiling / 2);
  return backoff + Math.random() * backoff;
}

/** Wait `ms`, or reject with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

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
 *
 * The caller's `signal` ends the call at once, during an attempt or a wait,
 * with the signal's reason; nothing is sent when it is aborted already.
 */
export async function send(
  config: ResolvedConfig,
  req: BuiltRequest,
  signal?: AbortSignal,
): Promise<RawResponse> {
  const headers: Record<string, string> = { ...req.headers, ...authHeaders(config) };
  if (req.contentType) headers['Content-Type'] = req.contentType;
  if (req.accept) headers['Accept'] = req.accept;

  const body =
    req.jsonBody !== undefined ? JSON.stringify(req.jsonBody) : req.rawBody;
  const url = buildUrl(config.baseUrl, req.path, req.query);

  const started = performance.now();
  let countedRetries = 0;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    // A fresh controller per attempt: an aborted signal stays aborted, so
    // reusing one would fail every retry instantly.
    const controller = new AbortController();
    // A listener removed after each attempt, not AbortSignal.any: some Node
    // releases this package supports keep every signal AbortSignal.any made
    // until its source aborts, so one long-lived caller signal would grow.
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer =
      config.timeoutMs > 0
        ? setTimeout(() => controller.abort(), config.timeoutMs)
        : undefined;

    let res: Response | undefined;
    let failure: unknown;
    let kind: RetryClass;
    try {
      res = await config.fetchImpl(url, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      });

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.ok) return { status: res.status, headers: res.headers, bytes };

      failure = errorFromResponse(res.status, bytes, res.headers);
      kind = retryClass(failure);
    } catch (err) {
      signal?.throwIfAborted();
      // Otherwise an abort is this client's own deadline, not a server fault:
      // the request may still be running, and a repeat would take as long again.
      if (controller.signal.aborted) {
        throw new BeliqApiError(
          `beliq: request to ${req.path} exceeded ${config.timeoutMs}ms`,
          { status: 0, code: 'TIMEOUT' },
        );
      }
      failure = err;
      kind = retryClass(err);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }

    if (kind === 'none') throw failure;
    // `attempt` is also the number of retries so far.
    if (config.maxRetries !== undefined) {
      if (attempt >= config.maxRetries) throw failure;
    } else if (kind === 'count' && countedRetries >= DEFAULT_MAX_RETRIES) {
      throw failure;
    }
    const delay = retryDelayMs(res, attempt, config);
    if (performance.now() - started + delay > config.retryBudgetMs) throw failure;

    if (kind === 'count') countedRetries++;
    await sleep(delay, signal);
  }
}
