/**
 * Timeout and retry behaviour.
 *
 * Before this the SDK had neither: a call hung until whatever wrapped it gave up,
 * and a 429 or 503 surfaced as an error even though both arrive with a
 * `Retry-After` telling you exactly when to try again. Since beliq's own docs
 * tell customers to retry those, the client not doing it meant every integrator
 * had to reimplement it, usually without honouring the header.
 */
import { describe, it, expect, vi } from 'vitest';
import { Beliq } from '../src/client';
import { BeliqApiError } from '../src/errors';
import { DEFAULT_MAX_RETRIES } from '../src/index';

const API_KEY = 'blq_test_key';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, code: string, headers: Record<string, string> = {}) {
  return jsonResponse({ success: false, error: { code, message: code } }, status, headers);
}

function client(fetchImpl: typeof fetch, opts: Partial<{ maxRetries: number; timeoutMs: number }> = {}) {
  return new Beliq({ apiKey: API_KEY, fetch: fetchImpl, maxRetries: 0, timeoutMs: 5_000, ...opts });
}

describe('transport retries', () => {
  it('retries a 503 and succeeds, honouring Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, 'ENGINE_UNAVAILABLE', { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { plan: 'starter' } }));

    const result = await client(fetchImpl as unknown as typeof fetch, { maxRetries: 3 }).me();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ plan: 'starter' });
  });

  it('retries a 429 rather than surfacing it on the first attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, 'RATE_LIMITED', { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { plan: 'free' } }));

    await client(fetchImpl as unknown as typeof fetch, { maxRetries: 2 }).me();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 429 whose body says the monthly quota is spent', async () => {
    // The `Retry-After` here is the real shape: seconds to the end of the billing
    // window. Retrying it sleeps at the 30s ceiling three times and then surfaces a
    // timeout from whatever wraps the call, hiding the message that names the cause.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        errorResponse(429, 'QUOTA_EXCEEDED', { 'retry-after': String(29 * 24 * 60 * 60) }),
      );

    await expect(client(fetchImpl as unknown as typeof fetch, { maxRetries: 3 }).me()).rejects.toMatchObject({
      status: 429,
      code: 'QUOTA_EXCEEDED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still retries the two 429s that waiting does clear', async () => {
    for (const code of ['RATE_LIMITED', 'ACCOUNT_THROTTLED']) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(429, code, { 'retry-after': '0' }))
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { plan: 'free' } }));

      await client(fetchImpl as unknown as typeof fetch, { maxRetries: 2 }).me();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('does not retry a 504', async () => {
    // The one status where a retry can duplicate a document: the work may still
    // be running server-side, so the safe move is to surface it.
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(504, 'ENGINE_UNAVAILABLE'));

    await expect(client(fetchImpl as unknown as typeof fetch, { maxRetries: 3 }).me()).rejects.toThrow(
      BeliqApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 4xx that is the caller’s own fault', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(403, 'INVALID_API_KEY'));

    await expect(client(fetchImpl as unknown as typeof fetch, { maxRetries: 3 }).me()).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and surfaces the last error', async () => {
    // A fresh Response per call: a body can only be read once, so a shared
    // instance would fail on the second attempt for the wrong reason.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(errorResponse(503, 'ENGINE_UNAVAILABLE', { 'retry-after': '0' })),
    );

    await expect(client(fetchImpl as unknown as typeof fetch, { maxRetries: 2 }).me()).rejects.toMatchObject({
      status: 503,
      code: 'ENGINE_UNAVAILABLE',
    });
    // First attempt plus two retries.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry at all when maxRetries is 0', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(503, 'ENGINE_UNAVAILABLE'));

    await expect(client(fetchImpl as unknown as typeof fetch).me()).rejects.toThrow(BeliqApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the exported DEFAULT_MAX_RETRIES when none is given', async () => {
    // The constant is public, so a caller can reason about the default without
    // hardcoding it. That only holds if it is the value the client actually uses.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(errorResponse(503, 'ENGINE_UNAVAILABLE', { 'retry-after': '0' })),
    );

    await expect(
      new Beliq({ apiKey: API_KEY, fetch: fetchImpl as unknown as typeof fetch }).me(),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });
});

describe('transport timeout', () => {
  it('aborts a hanging request and reports it as a timeout', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
    );

    await expect(
      client(fetchImpl as unknown as typeof fetch, { timeoutMs: 30 }).me(),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('does not retry a timeout', async () => {
    // Same reasoning as the 504: our own deadline firing says nothing about
    // whether the server finished the work.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
    );

    await expect(
      client(fetchImpl as unknown as typeof fetch, { timeoutMs: 30, maxRetries: 3 }).me(),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes a fresh abort signal per attempt', async () => {
    // Reusing one controller across retries would leave it aborted, failing
    // every subsequent attempt instantly.
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = vi
      .fn((_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        return Promise.resolve(
          signals.length === 1
            ? errorResponse(503, 'ENGINE_UNAVAILABLE', { 'retry-after': '0' })
            : jsonResponse({ success: true, data: { plan: 'free' } }),
        );
      });

    await client(fetchImpl as unknown as typeof fetch, { maxRetries: 2 }).me();

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });
});
