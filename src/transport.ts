import type { BuiltRequest } from './buildRequest';
import { errorFromResponse, BeliqApiError } from './errors';

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  auth: 'header' | 'bearer';
  fetchImpl: typeof fetch;
  /** Per-attempt deadline in ms. 0 disables. */
  timeoutMs: number;
  /** Extra attempts after the first. 0 disables retrying. */
  maxRetries: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

/**
 * Statuses worth another attempt.
 *
 * 429 and 503 both arrive with `Retry-After`, and beliq refunds the document's
 * quota unit on a 503, so retrying one costs nothing. 502 means the request never
 * reached the API.
 *
 * 504 is deliberately excluded. It means the work may still be running
 * server-side, so a retry can duplicate a document rather than recover one. Same
 * reasoning beliq itself applies between its API and engine tiers.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503]);

/**
 * The one 429 waiting cannot clear. `RATE_LIMITED` frees up in seconds and
 * `ACCOUNT_THROTTLED` in minutes, but a spent monthly allowance only returns when
 * the billing window turns, and beliq says so honestly: its `Retry-After` on this
 * code is the seconds remaining in the window, which can be weeks. Retrying spends
 * `maxRetries` sleeps of `MAX_RETRY_AFTER_MS` each against a refusal that is
 * already final, and whatever wraps the call usually times out first, so the caller
 * is told the request hung rather than that the quota is gone.
 */
const QUOTA_EXHAUSTED_CODE = 'QUOTA_EXCEEDED';

function isRetryable(status: number, code?: string): boolean {
  if (!RETRYABLE_STATUSES.has(status)) return false;
  return !(status === 429 && code === QUOTA_EXHAUSTED_CODE);
}

/** Ceiling on a server-supplied `Retry-After`, so one header cannot hang a call for minutes. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Base for exponential backoff when no `Retry-After` is given. */
const BACKOFF_BASE_MS = 500;

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
 * Delay before the next attempt: the server's `Retry-After` when it sent one,
 * otherwise exponential backoff. Jittered either way so a fleet of clients that
 * were throttled together does not return in lockstep.
 */
function retryDelayMs(res: Response | undefined, attempt: number): number {
  const header = res?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) + Math.random() * 250;
    }
  }
  const backoff = BACKOFF_BASE_MS * 2 ** attempt;
  return backoff + Math.random() * backoff;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Perform the request and return the raw response. Throws BeliqApiError on any
 * non-2xx status (the body is parsed for the `{ success:false, error }`
 * envelope). The caller interprets a 2xx body per the request's outputKind.
 *
 * Retries transient failures automatically, honouring `Retry-After`. A document
 * request can legitimately take tens of seconds, because beliq runs the full
 * Schematron rule set over it, so the per-attempt deadline is generous by
 * default: it exists to stop a call hanging forever, not to bound normal work.
 */
export async function send(config: ResolvedConfig, req: BuiltRequest): Promise<RawResponse> {
  const headers: Record<string, string> = { ...authHeaders(config) };
  if (req.contentType) headers['Content-Type'] = req.contentType;
  if (req.accept) headers['Accept'] = req.accept;

  const body =
    req.jsonBody !== undefined ? JSON.stringify(req.jsonBody) : req.rawBody;
  const url = buildUrl(config.baseUrl, req.path, req.query);

  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    // A fresh controller per attempt: an aborted signal stays aborted, so
    // reusing one would fail every retry instantly.
    const controller = new AbortController();
    const timer =
      config.timeoutMs > 0
        ? setTimeout(() => controller.abort(), config.timeoutMs)
        : undefined;

    let res: Response | undefined;
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
      lastError = apiError;
      if (!isRetryable(apiError.status, apiError.code) || attempt === config.maxRetries) {
        throw apiError;
      }
    } catch (err) {
      if (err instanceof BeliqApiError && !isRetryable(err.status, err.code)) throw err;
      // An abort is this client's own deadline, not a server fault: the request
      // may have been received and be running, so retrying risks a duplicate.
      if (controller.signal.aborted) {
        throw new BeliqApiError(
          `beliq: request to ${req.path} exceeded ${config.timeoutMs}ms`,
          { status: 0, code: 'TIMEOUT' },
        );
      }
      lastError = err;
      if (attempt === config.maxRetries) throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    await sleep(retryDelayMs(res, attempt));
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw lastError;
}
