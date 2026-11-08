import type { ApiErrorCode } from './types';
import { decodeUtf8, isPlainObject } from './internal';

/**
 * Thrown for any non-2xx beliq response (and for a 2xx body carrying
 * `{ success: false }`). Carries the typed error `code`, HTTP `status`, and any
 * structured `details` from beliq's `{ success: false, error: {...} }` envelope.
 */
export class BeliqApiError extends Error {
  readonly code?: ApiErrorCode | string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /**
   * The response's `Retry-After` in seconds, when it gave one as a number of
   * seconds; `undefined` otherwise, an HTTP date included. The retry loop reads
   * the header the same way, so this is the wait it would have taken.
   */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    opts: {
      code?: ApiErrorCode | string;
      status: number;
      details?: Record<string, unknown>;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = 'BeliqApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/** A `Retry-After` given as delay-seconds; `undefined` for any other form or none. */
export function parseRetryAfterSeconds(headers: Headers | undefined): number | undefined {
  const header = headers?.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

interface ParsedEnvelope {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
  message?: string;
}

/** Parse a beliq JSON envelope from raw response bytes; null if it is not JSON. */
export function parseEnvelope(bytes: Uint8Array): ParsedEnvelope | null {
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? (parsed as ParsedEnvelope) : null;
  } catch {
    return null;
  }
}

/** Build a BeliqApiError from a failed response's status, headers and raw body bytes. */
export function errorFromResponse(
  status: number,
  bytes: Uint8Array,
  headers?: Headers,
): BeliqApiError {
  const envelope = parseEnvelope(bytes);
  const err = envelope?.error;
  const message =
    err?.message ?? envelope?.message ?? `beliq request failed with status ${status}`;
  return new BeliqApiError(message, {
    code: err?.code,
    status,
    details: err?.details,
    retryAfterSeconds: parseRetryAfterSeconds(headers),
  });
}
