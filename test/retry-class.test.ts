/**
 * `retryClass`, `retryAfterSeconds` and a caller's `signal`, against a real HTTP
 * server on 127.0.0.1.
 *
 * A connector whose host gives a step 30 or 60 seconds cannot sit in the
 * client's 15-minute budget. It turns the retry off and hands the failure to
 * the host's own retry instead, which needs to know two things: whether the
 * client would have retried this failure, and how long the server asked it to
 * wait. A worker that stops on a signal needs the wait to end when it stops.
 *
 * The agreement cases count the attempts the client really makes for each
 * failure and check that `retryClass` names the class those attempts show: one
 * attempt is `none`, the count's attempts are `count`, more is `budget`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Beliq } from '../src/client';
import { buildRequest } from '../src/buildRequest';
import { BeliqApiError } from '../src/errors';
import { DEFAULT_MAX_RETRIES, retryClass, type RetryClass } from '../src/index';
import { send, type ResolvedConfig } from '../src/transport';
import type { ApiErrorCode } from '../src/types';

const API_KEY = 'blq_test_key';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Start a server, run the body, close the server, whatever the body did. */
async function withServer(handler: Handler, body: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await body((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function answer(status: number, code?: ApiErrorCode, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    const body =
      code === undefined
        ? 'Service Unavailable'
        : JSON.stringify({ success: false, error: { code, message: code } });
    res.writeHead(status, {
      'content-type': code === undefined ? 'text/plain' : 'application/json',
      ...headers,
    });
    res.end(body);
  };
}

/** A port nothing listens on: bound once, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** What undici throws for a fetch that failed, with the socket error as its cause. */
function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

/** Long enough for many budget retries at the test backoff, short enough to run quickly. */
const TEST_BUDGET_MS = 1_500;

/**
 * Run one call through the real retry loop with a short budget and a tiny
 * backoff, and report how many attempts it made and what it threw.
 */
async function observe(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ attempts: number; thrown: unknown }> {
  let attempts = 0;
  const inner = opts.fetchImpl ?? globalThis.fetch;
  const config: ResolvedConfig = {
    apiKey: API_KEY,
    baseUrl,
    auth: 'header',
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
      attempts++;
      return inner(input, init);
    }) as typeof fetch,
    timeoutMs: opts.timeoutMs ?? 5_000,
    retryBudgetMs: TEST_BUDGET_MS,
    backoffBaseMs: 1,
    backoffCeilingMs: 4,
  };
  try {
    await send(config, buildRequest({ operation: 'me' }));
  } catch (thrown) {
    return { attempts, thrown };
  }
  throw new Error('the call succeeded; every case here must fail');
}

/** The class the attempts show. */
function shownClass(attempts: number): RetryClass {
  if (attempts === 1) return 'none';
  if (attempts === DEFAULT_MAX_RETRIES + 1) return 'count';
  return 'budget';
}

describe.concurrent('retryClass agrees with the retries the client makes', () => {
  const statusCases: Array<[string, Handler, RetryClass]> = [
    ['503 DATABASE_UNAVAILABLE', answer(503, 'DATABASE_UNAVAILABLE', { 'retry-after': '0' }), 'budget'],
    ['503 with no beliq code', answer(503, undefined, { 'retry-after': '0' }), 'budget'],
    ['502 with no beliq code', answer(502, undefined, { 'retry-after': '0' }), 'budget'],
    ['503 ENGINE_UNAVAILABLE', answer(503, 'ENGINE_UNAVAILABLE', { 'retry-after': '0' }), 'count'],
    ['502 DATABASE_UNAVAILABLE', answer(502, 'DATABASE_UNAVAILABLE', { 'retry-after': '0' }), 'count'],
    ['429 RATE_LIMITED', answer(429, 'RATE_LIMITED', { 'retry-after': '0' }), 'count'],
    ['429 QUOTA_EXCEEDED', answer(429, 'QUOTA_EXCEEDED', { 'retry-after': '0' }), 'none'],
    ['504 with no beliq code', answer(504), 'none'],
    ['422 VALIDATION_ERROR', answer(422, 'VALIDATION_ERROR'), 'none'],
    ['401 INVALID_API_KEY', answer(401, 'INVALID_API_KEY'), 'none'],
  ];

  for (const [label, handler, expected] of statusCases) {
    it(label, async ({ expect }) => {
      await withServer(handler, async (port) => {
        const { attempts, thrown } = await observe(`http://127.0.0.1:${port}`);
        expect(shownClass(attempts)).toBe(expected);
        expect(retryClass(thrown)).toBe(expected);
      });
    });
  }

  it('a refused connection', async ({ expect }) => {
    const { attempts, thrown } = await observe(`http://127.0.0.1:${await closedPort()}`);
    expect(shownClass(attempts)).toBe('budget');
    expect(retryClass(thrown)).toBe('budget');
  });

  it('a connection closed after the request was sent', async ({ expect }) => {
    await withServer(
      (req) => req.socket.destroy(),
      async (port) => {
        const { attempts, thrown } = await observe(`http://127.0.0.1:${port}`);
        expect(shownClass(attempts)).toBe('count');
        expect(retryClass(thrown)).toBe('count');
      },
    );
  });

  it("the client's own timeout", async ({ expect }) => {
    await withServer(
      () => undefined,
      async (port) => {
        const { attempts, thrown } = await observe(`http://127.0.0.1:${port}`, { timeoutMs: 100 });
        expect(thrown).toMatchObject({ code: 'TIMEOUT' });
        expect(shownClass(attempts)).toBe('none');
        expect(retryClass(thrown)).toBe('none');
      },
    );
  });

  it('an OpenSSL error: https to a socket that answers plain HTTP', async ({ expect }) => {
    // undici reports it as `fetch failed` caused by ERR_SSL_WRONG_VERSION_NUMBER,
    // measured on Node 22.23. An `ERR_SSL_*` code can also end a connection
    // after the send, and nothing in it says which, so it stays on the count.
    await withServer(answer(200, undefined), async (port) => {
      const { attempts, thrown } = await observe(`https://127.0.0.1:${port}`);
      expect((thrown as { cause?: { code?: string } }).cause?.code).toBe('ERR_SSL_WRONG_VERSION_NUMBER');
      expect(shownClass(attempts)).toBe('count');
      expect(retryClass(thrown)).toBe('count');
    });
  });

  it('a self-signed certificate, from a real HTTPS server', async ({ expect }) => {
    const dir = mkdtempSync(join(tmpdir(), 'beliq-sdk-tls-'));
    try {
      const key = join(dir, 'key.pem');
      const cert = join(dir, 'cert.pem');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-days', '1', '-subj', '/CN=localhost',
      ], { stdio: 'ignore' });
      const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) =>
        res.end('ok'),
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      try {
        const { port } = server.address() as AddressInfo;
        const { attempts, thrown } = await observe(`https://localhost:${port}`);
        expect((thrown as { cause?: { code?: string } }).cause?.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
        expect(shownClass(attempts)).toBe('none');
        expect(retryClass(thrown)).toBe('none');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other certificate failures, in the shape undici throws them: measured
  // on Node 22.23 for a certificate for another name
  // (ERR_TLS_CERT_ALTNAME_INVALID, which needs the certificate trusted, so a
  // process started with NODE_EXTRA_CA_CERTS); the rest are from Node's list of
  // X509 certificate error codes
  // (https://nodejs.org/api/tls.html#x509-certificate-error-codes).
  for (const code of [
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'HOSTNAME_MISMATCH',
  ]) {
    it(`a certificate that fails verification: ${code}`, async ({ expect }) => {
      const { attempts, thrown } = await observe('https://beliq.invalid', {
        fetchImpl: (() => Promise.reject(fetchFailed(code))) as typeof fetch,
      });
      expect(shownClass(attempts)).toBe('none');
      expect(retryClass(thrown)).toBe('none');
    });
  }
});

describe('retryClass on what a caller holds', () => {
  it('reads a BeliqApiError by its status and code', () => {
    expect(retryClass(new BeliqApiError('x', { status: 503, code: 'DATABASE_UNAVAILABLE' }))).toBe('budget');
    expect(retryClass(new BeliqApiError('x', { status: 503, code: 'ENGINE_UNAVAILABLE' }))).toBe('count');
    expect(retryClass(new BeliqApiError('x', { status: 200 }))).toBe('none');
  });
});

describe.concurrent('retryAfterSeconds', () => {
  const cases: Array<[string, Record<string, string>, number | undefined]> = [
    ['Retry-After: 30', { 'retry-after': '30' }, 30],
    ['Retry-After: 0', { 'retry-after': '0' }, 0],
    ['no Retry-After', {}, undefined],
    // The retry loop reads delay-seconds only and backs off on any other form,
    // so the field says what the loop would have waited on.
    ['an HTTP-date', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, undefined],
    ['a negative number', { 'retry-after': '-5' }, undefined],
    // RFC 9110 delay-seconds is 1*DIGIT; Number() would read these as 1.5 and 30.
    ['a fraction', { 'retry-after': '1.5' }, undefined],
    ['a hex literal', { 'retry-after': '0x1E' }, undefined],
  ];

  for (const [label, headers, expected] of cases) {
    it(label, async ({ expect }) => {
      await withServer(answer(503, 'DATABASE_UNAVAILABLE', headers), async (port) => {
        const beliq = new Beliq({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}`, retryBudgetMs: 0 });
        const thrown = await beliq.me().catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(BeliqApiError);
        expect((thrown as BeliqApiError).retryAfterSeconds).toBe(expected);
      });
    });
  }
});

describe.concurrent('a caller signal', () => {
  it('ends a Retry-After wait at once with its reason', async ({ expect }) => {
    let requests = 0;
    const handler = answer(503, 'DATABASE_UNAVAILABLE', { 'retry-after': '30' });
    await withServer(
      (req, res) => {
        requests++;
        handler(req, res);
      },
      async (port) => {
        const beliq = new Beliq({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` });
        const controller = new AbortController();
        const reason = new Error('worker stopping');
        const started = performance.now();
        setTimeout(() => controller.abort(reason), 200);
        await expect(beliq.me({ signal: controller.signal })).rejects.toBe(reason);
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(requests).toBe(1);
      },
    );
  });

  it('ends an attempt in flight with its reason, not as a timeout', async ({ expect }) => {
    await withServer(
      () => undefined,
      async (port) => {
        const beliq = new Beliq({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const thrown = await beliq.me({ signal: controller.signal }).catch((e: unknown) => e);
        expect(thrown).toBe(controller.signal.reason);
      },
    );
  });

  it('keeps the client timeout a TIMEOUT while the signal is not aborted', async ({ expect }) => {
    await withServer(
      () => undefined,
      async (port) => {
        const beliq = new Beliq({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 100 });
        await expect(beliq.me({ signal: new AbortController().signal })).rejects.toMatchObject({
          code: 'TIMEOUT',
        });
      },
    );
  });

  it('sends nothing when it is aborted already, on every method', async ({ expect }) => {
    let requests = 0;
    await withServer(
      (_req, res) => {
        requests++;
        res.end();
      },
      async (port) => {
        const beliq = new Beliq({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` });
        const signal = AbortSignal.abort(new Error('stopped'));
        const xml = '<Invoice/>';
        const calls = [
          beliq.me({ signal }),
          beliq.validate(xml, { signal }),
          beliq.parse(xml, { signal }),
          beliq.convert(xml, { targetFormat: 'ubl', signal }),
          beliq.generate({ standard: 'xrechnung', invoice: {} as never }, { signal }),
        ];
        for (const call of calls) await expect(call).rejects.toThrow('stopped');
        expect(requests).toBe(0);
      },
    );
  });
});
