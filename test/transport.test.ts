/**
 * Timeout and retry behaviour.
 *
 * Before this the SDK had neither: a call hung until whatever wrapped it gave up,
 * and a 429 or 503 surfaced as an error even though both arrive with a
 * `Retry-After` telling you exactly when to try again. Since beliq's own docs
 * tell customers to retry those, the client not doing it meant every integrator
 * had to reimplement it, usually without honouring the header.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Beliq } from '../src/client';
import { BeliqApiError } from '../src/errors';
import { DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BUDGET_MS } from '../src/index';

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

function client(
  fetchImpl: typeof fetch,
  opts: Partial<{ maxRetries: number; timeoutMs: number; retryBudgetMs: number }> = {},
) {
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
    // window. No wait clears it sooner, so it is raised at once and names the cause.
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

/** What undici throws for a fetch that failed, with the socket error as its cause. */
function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

function defaults(fetchImpl: typeof fetch, opts: Partial<{ retryBudgetMs: number }> = {}) {
  return new Beliq({ apiKey: API_KEY, fetch: fetchImpl, timeoutMs: 5_000, ...opts });
}

/** Fails `failures` times with `fail()`, then answers 200. */
function failingThenOk(failures: number, fail: () => Promise<Response>) {
  let calls = 0;
  return vi.fn(() => (++calls <= failures ? fail() : Promise.resolve(jsonResponse({ success: true, data: { plan: 'free' } }))));
}

describe('retry classes', () => {
  // More failures than the count allows, so only a class the count does not
  // bound gets through them.
  const PAST_THE_COUNT = DEFAULT_MAX_RETRIES + 3;

  it('retries 503 DATABASE_UNAVAILABLE past the count, by the budget', async () => {
    const fetchImpl = failingThenOk(PAST_THE_COUNT, () =>
      Promise.resolve(errorResponse(503, 'DATABASE_UNAVAILABLE', { 'retry-after': '0' })),
    );

    await defaults(fetchImpl as unknown as typeof fetch).me();
    expect(fetchImpl).toHaveBeenCalledTimes(PAST_THE_COUNT + 1);
  });

  it('retries a 502 and a 503 with no beliq error code past the count', async () => {
    for (const status of [502, 503]) {
      const fetchImpl = failingThenOk(PAST_THE_COUNT, () =>
        Promise.resolve(new Response('Bad Gateway', { status, headers: { 'retry-after': '0' } })),
      );

      await defaults(fetchImpl as unknown as typeof fetch).me();
      expect(fetchImpl).toHaveBeenCalledTimes(PAST_THE_COUNT + 1);
    }
  });

  it('retries a connection that could not be opened past the count', async () => {
    // No Retry-After, so the waits are the backoff's: fake timers run them.
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    try {
      for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
        const fetchImpl = failingThenOk(PAST_THE_COUNT, () => Promise.reject(fetchFailed(code)));

        const call = defaults(fetchImpl as unknown as typeof fetch).me();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await expect(call).resolves.toMatchObject({ plan: 'free' });
        expect(fetchImpl).toHaveBeenCalledTimes(PAST_THE_COUNT + 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries ENGINE_UNAVAILABLE and the other coded 502 and 503 answers by the count only', async () => {
    for (const [status, code] of [
      [503, 'ENGINE_UNAVAILABLE'],
      [502, 'ENGINE_UNAVAILABLE'],
      [503, 'CONVERSION_TOOL_UNAVAILABLE'],
      [502, 'DATABASE_UNAVAILABLE'],
    ] as const) {
      const fetchImpl = vi.fn(() => Promise.resolve(errorResponse(status, code, { 'retry-after': '0' })));

      await expect(defaults(fetchImpl as unknown as typeof fetch).me()).rejects.toMatchObject({ status, code });
      expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
    }
  });

  it('retries RATE_LIMITED by the count only', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(errorResponse(429, 'RATE_LIMITED', { 'retry-after': '0' })));

    await expect(defaults(fetchImpl as unknown as typeof fetch).me()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });

  it('retries a connection lost after the send by the count only, and throws it as it came', async () => {
    // ECONNRESET and a socket closed mid-body happen on both sides of the send,
    // and whatever a caller's own fetch throws carries no cause code at all.
    for (const thrown of [fetchFailed('ECONNRESET'), fetchFailed('UND_ERR_SOCKET'), new Error('custom fetch broke')]) {
      const fetchImpl = vi.fn(() => Promise.reject(thrown));

      await expect(defaults(fetchImpl as unknown as typeof fetch).me()).rejects.toBe(thrown);
      expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
    }
  });

  it('caps every class when the caller sets maxRetries', async () => {
    const database = vi.fn(() =>
      Promise.resolve(errorResponse(503, 'DATABASE_UNAVAILABLE', { 'retry-after': '0' })),
    );
    await expect(client(database as unknown as typeof fetch, { maxRetries: 2 }).me()).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
    });
    expect(database).toHaveBeenCalledTimes(3);

    const refused = vi.fn(() => Promise.reject(fetchFailed('ECONNREFUSED')));
    await expect(client(refused as unknown as typeof fetch, { maxRetries: 0 }).me()).rejects.toThrow('fetch failed');
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('does not retry at all when retryBudgetMs is 0', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(errorResponse(503, 'DATABASE_UNAVAILABLE', { 'retry-after': '0' })),
    );

    await expect(defaults(fetchImpl as unknown as typeof fetch, { retryBudgetMs: 0 }).me()).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('retry waits', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits a Retry-After longer than 30 s in full', async () => {
    // The header was capped at 30 s before the budget existed; now the budget
    // is what keeps one header from hanging a call, so the server's value holds.
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const fetchImpl = failingThenOk(1, () =>
      Promise.resolve(errorResponse(503, 'DATABASE_UNAVAILABLE', { 'retry-after': '45' })),
    );

    const call = defaults(fetchImpl as unknown as typeof fetch).me();
    await vi.advanceTimersByTimeAsync(44_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(call).resolves.toMatchObject({ plan: 'free' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops at the exported DEFAULT_RETRY_BUDGET_MS when none is given', async () => {
    // Retry-After: 60 against a 900 s budget: attempts at 0, 60, ... 840 s, and
    // the wait after the one at 840 s would start an attempt past the budget.
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(errorResponse(503, 'DATABASE_UNAVAILABLE', { 'retry-after': '60' })),
    );

    const call = defaults(fetchImpl as unknown as typeof fetch).me();
    const settled = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_BUDGET_MS);
    await expect(settled).resolves.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_RETRY_BUDGET_MS / 60_000);
  });
});
