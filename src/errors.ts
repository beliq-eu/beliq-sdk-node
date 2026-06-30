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

  constructor(
    message: string,
    opts: { code?: ApiErrorCode | string; status: number; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'BeliqApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
  }
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

/** Build a BeliqApiError from a failed response's status and raw body bytes. */
export function errorFromResponse(status: number, bytes: Uint8Array): BeliqApiError {
  const envelope = parseEnvelope(bytes);
  const err = envelope?.error;
  const message =
    err?.message ?? envelope?.message ?? `beliq request failed with status ${status}`;
  return new BeliqApiError(message, { code: err?.code, status, details: err?.details });
}
