import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = join(root, 'openapi.json');

/**
 * The vendored spec has to be byte-identical to the copy beliq-api generates and
 * to the one the Python SDK vendors: three copies of one contract, and a client
 * generated from a stale or differently-serialized one types the API wrongly.
 *
 * Byte equality across three languages only holds if every copy is serialized
 * the same way, and that is where it broke: `scripts/sync_spec.py` used
 * `json.dumps` at its default `ensure_ascii=True`, so the Python copy escaped
 * every non-ASCII character in a description and could never match, however
 * often it was re-synced.
 *
 * Re-serializing here and requiring a fixpoint catches that class without
 * needing the sibling checkout the SDK's CI does not have.
 */
describe('vendored openapi.json', () => {
  it('is exactly what scripts/sync-spec.mjs would write', () => {
    const text = readFileSync(vendored, 'utf8');
    const canonical = JSON.stringify(JSON.parse(text), null, 2) + '\n';
    expect(
      text === canonical,
      'openapi.json is not in canonical form, so it was written by something ' +
        'other than the current sync script. Run `node scripts/sync-spec.mjs` ' +
        'and commit the result.',
    ).toBe(true);
  });

  it('advertises a document version that is not the placeholder', () => {
    const spec = JSON.parse(readFileSync(vendored, 'utf8'));
    expect(spec.info.version).toBeTruthy();
    expect(spec.info.version).not.toBe('0.1.0');
  });
});
