import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Beliq, BeliqTimeoutError } from '../src/index';

const apiKey = 'blq_test_key';

describe('request timeout', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Accepts the connection but never sends a response, so the only way the
    // request ends is the client-side timeout firing.
    server = createServer(() => {
      /* intentionally never responds */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects with BeliqTimeoutError when the server never responds', async () => {
    const client = new Beliq({ apiKey, baseUrl, timeout: 150 });
    await expect(client.me()).rejects.toBeInstanceOf(BeliqTimeoutError);
  });

  it('carries the configured timeout on the error', async () => {
    const client = new Beliq({ apiKey, baseUrl, timeout: 120 });
    await expect(client.me()).rejects.toMatchObject({ timeoutMs: 120 });
  });

  it('rejects a non-positive timeout at construction', () => {
    expect(() => new Beliq({ apiKey, timeout: 0 })).toThrow(/positive number/);
  });
});
