/**
 * The `ruleset` option of validate, against a real HTTP server on 127.0.0.1.
 *
 * `POST /v1/validate` reads the `Beliq-Ruleset` request header to choose the
 * rules a document is checked against. With no header, the API runs the key's
 * organisation default, which is `latest` unless the organisation chose
 * `previous`. So the client sends the header only when the caller sets the
 * option: a header sent by default would override that organisation choice.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Beliq } from '../src/client';

const API_KEY = 'blq_test_key';
const DOCUMENT = '<Invoice/>';

const VALIDATE_BODY = JSON.stringify({
  success: true,
  data: JSON.parse(
    readFileSync(new URL('./fixtures/live-validate-france-previous.json', import.meta.url), 'utf8'),
  ),
});

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
}

/** Start a server that answers every request with a validate 200 and records what it got. */
async function withServer(body: (baseUrl: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(VALIDATE_BODY);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

function client(baseUrl: string): Beliq {
  return new Beliq({ apiKey: API_KEY, baseUrl, maxRetries: 0 });
}

describe('validate: the ruleset option on the wire', () => {
  it('(1) ruleset: previous sends Beliq-Ruleset: previous', async () => {
    await withServer(async (baseUrl, seen) => {
      await client(baseUrl).validate(DOCUMENT, { ruleset: 'previous' });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url?.startsWith('/v1/validate')).toBe(true);
      expect(seen[0]!.headers['beliq-ruleset']).toBe('previous');
    });
  });

  it('(2) no ruleset option sends no Beliq-Ruleset header', async () => {
    await withServer(async (baseUrl, seen) => {
      await client(baseUrl).validate(DOCUMENT);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers).not.toHaveProperty('beliq-ruleset');
    });
  });
});
