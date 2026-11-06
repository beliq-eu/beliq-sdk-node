/**
 * The retry budget against a real HTTP server on 127.0.0.1.
 *
 * While beliq's database is out, the API answers 503 `DATABASE_UNAVAILABLE` with
 * `Retry-After: 30`, and the outages beliq has measured lasted 9 to 12 minutes.
 * A client that stops after 3 retries gives up about 2 minutes in, so every
 * caller loses its call. These cases hold the client to a time budget instead: it rides a
 * window shorter than the budget, gives up once the budget is spent, follows the
 * server's `Retry-After` in full, and keeps its own backoff under a ceiling.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'vitest';
import { Beliq } from '../src/client';
import { buildRequest } from '../src/buildRequest';
import { BeliqApiError } from '../src/errors';
import { send, type ResolvedConfig } from '../src/transport';

const API_KEY = 'blq_test_key';

/** What the server answers to its n-th request (0-based), `t` ms after the first one. */
type Answer = (n: number, t: number) => { status: number; headers?: Record<string, string>; body: string };

const OK: ReturnType<Answer> = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ success: true, data: { plan: 'free' } }),
};

function databaseUnavailable(retryAfter?: string): ReturnType<Answer> {
  return {
    status: 503,
    headers: {
      'content-type': 'application/json',
      ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
    },
    body: JSON.stringify({
      success: false,
      error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable.' },
    }),
  };
}

/** The edge's own 503: no beliq envelope, no error code, no `Retry-After`. */
const EDGE_503: ReturnType<Answer> = {
  status: 503,
  headers: { 'content-type': 'text/plain' },
  body: 'Service Unavailable',
};

interface Stub {
  port: number;
  /** Arrival time of each request, ms since the first one. */
  arrivals: number[];
  server: Server;
}

type Track = (server: Server) => Server;

/**
 * Run a test body and close every server it started when it ends. A finally of
 * its own, not an afterEach or onTestFinished hook: the tests run concurrently,
 * and vitest runs those hooks only once the slowest test of the suite is done.
 */
async function scoped(body: (track: Track) => Promise<void>): Promise<void> {
  const started: Server[] = [];
  try {
    await body((server) => {
      started.push(server);
      return server;
    });
  } finally {
    await Promise.all(
      started.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          }),
      ),
    );
  }
}

function handler(answer: Answer, arrivals: number[]) {
  let first: number | undefined;
  return (req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      const now = performance.now();
      first ??= now;
      arrivals.push(now - first);
      const a = answer(arrivals.length - 1, now - first);
      res.writeHead(a.status, a.headers);
      res.end(a.body);
    });
  };
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function stub(track: Track, answer: Answer): Promise<Stub> {
  const arrivals: number[] = [];
  const server = track(createServer(handler(answer, arrivals)));
  return { port: await listen(server), arrivals, server };
}

/** A port nothing listens on yet: bound once to learn a free number, then closed. */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Start answering on `port` after `ms`; resolves with the moment it listened. */
function listenLater(
  track: Track,
  port: number,
  ms: number,
  answer: Answer,
): Promise<number> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const server = track(createServer(handler(answer, [])));
      listen(server, port).then(() => resolve(performance.now()), reject);
    }, ms);
  });
}

function client(port: number, retryBudgetMs: number): Beliq {
  return new Beliq({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}`, retryBudgetMs, timeoutMs: 5_000 });
}

/** The scaled-down backoff of case 4: base and ceiling in tens of ms instead of 500 ms and 30 s. */
const SCALED_BASE_MS = 10;
const SCALED_CEILING_MS = 200;
/** Scheduling noise on a loaded CI runner, on top of the ceiling. */
const SLACK_MS = 300;

function scaledConfig(port: number): ResolvedConfig {
  return {
    apiKey: API_KEY,
    baseUrl: `http://127.0.0.1:${port}`,
    auth: 'header',
    fetchImpl: fetch,
    timeoutMs: 5_000,
    retryBudgetMs: 30_000,
    backoffBaseMs: SCALED_BASE_MS,
    backoffCeilingMs: SCALED_CEILING_MS,
  };
}

const ME = buildRequest({ operation: 'me' });

// Concurrent, so each case takes `expect` from its own test context: the global
// one attaches a pending `.resolves` to whichever case is current.
describe.concurrent('retry budget (Done when, cases 1 to 5)', () => {
  it('(1) rides 20 s of 503 DATABASE_UNAVAILABLE with Retry-After: 1 inside a 30 s budget', ({ expect }) =>
    scoped(async (track) => {
      const s = await stub(track, (_n, t) => (t < 20_000 ? databaseUnavailable('1') : OK));
      const started = performance.now();

      await expect(client(s.port, 30_000).me()).resolves.toMatchObject({ plan: 'free' });

      expect(performance.now() - started).toBeGreaterThanOrEqual(20_000);
      expect(s.arrivals.length).toBeGreaterThan(4);
    }), 40_000);

  it('(2) ends in the 503 once the budget is spent, not before', ({ expect }) =>
    scoped(async (track) => {
      const budget = 8_000;
      const s = await stub(track, () => databaseUnavailable('1'));
      const started = performance.now();

      const err = await client(s.port, budget).me().catch((e: unknown) => e);
      const elapsed = performance.now() - started;

      expect(err).toBeInstanceOf(BeliqApiError);
      expect(err).toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
      // It stops when the next wait (1 s plus up to 250 ms of jitter) would start
      // an attempt past the budget, so no earlier than one wait before it ends.
      expect(elapsed).toBeGreaterThanOrEqual(budget - 1_250 - SLACK_MS);
      expect(elapsed).toBeLessThanOrEqual(budget + SLACK_MS);
    }), 20_000);

  it('(3) a refused connection inside the budget ends in success once the port listens', ({ expect }) =>
    scoped(async (track) => {
      const port = await freePort();
      const listening = listenLater(track, port, 8_000, () => OK);

      await expect(client(port, 30_000).me()).resolves.toMatchObject({ plan: 'free' });
      await listening;
    }), 40_000);

  it('(4a) refused connections past five doublings: success within one backoff ceiling of the window end', ({ expect }) =>
    scoped(async (track) => {
      const port = await freePort();
      const listening = listenLater(track, port, 2_000, () => OK);

      await send(scaledConfig(port), ME);
      const done = performance.now();

      expect(done - (await listening)).toBeLessThanOrEqual(SCALED_CEILING_MS + SLACK_MS);
    }), 20_000);

  it('(4b) 503s with no Retry-After past five doublings: no wait exceeds the ceiling', ({ expect }) =>
    scoped(async (track) => {
      const window = 2_000;
      const s = await stub(track, (_n, t) => (t < window ? EDGE_503 : OK));

      await send(scaledConfig(s.port), ME);

      const gaps = s.arrivals.slice(1).map((t, i) => t - s.arrivals[i]!);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(SCALED_CEILING_MS + SLACK_MS);
      expect(s.arrivals.at(-1)! - window).toBeLessThanOrEqual(SCALED_CEILING_MS + SLACK_MS);
    }), 20_000);

  it('(4c) a run of 503s with Retry-After, then one without: the next wait stays under the ceiling', ({ expect }) =>
    scoped(async (track) => {
      const run = 20;
      const s = await stub(track, (n) =>
        n < run ? databaseUnavailable('0') : n === run ? databaseUnavailable() : OK,
      );

      await send(scaledConfig(s.port), ME);

      expect(s.arrivals).toHaveLength(run + 2);
      expect(s.arrivals[run + 1]! - s.arrivals[run]!).toBeLessThanOrEqual(SCALED_CEILING_MS + SLACK_MS);
    }), 20_000);

  it('(5) a Retry-After longer than the budget left ends at once with the 503', ({ expect }) =>
    scoped(async (track) => {
      const s = await stub(track, (n) => (n === 0 ? databaseUnavailable('60') : OK));
      const started = performance.now();

      const err = await client(s.port, 5_000).me().catch((e: unknown) => e);

      expect(err).toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(s.arrivals).toHaveLength(1);
    }), 10_000);
});
