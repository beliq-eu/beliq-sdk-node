// Refreshes the vendored openapi.json. Reads the file BELIQ_OPENAPI_PATH names
// when that is set, and fetches the live spec otherwise. The
// vendored copy is committed so builds stay reproducible; run this only when
// the API surface changes, then `npm run gen:types` and commit both.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'openapi.json');
const local = process.env.BELIQ_OPENAPI_PATH;
const LIVE_URL = 'https://api.beliq.eu/openapi.json';

function normalize(text) {
  // Re-serialize so a trailing-newline / formatting difference never shows as drift.
  return JSON.stringify(JSON.parse(text), null, 2) + '\n';
}

if (local) {
  writeFileSync(dest, normalize(readFileSync(local, 'utf8')));
  console.log(`synced from ${local}`);
} else {
  const res = await fetch(LIVE_URL);
  if (!res.ok) throw new Error(`fetch ${LIVE_URL} failed: ${res.status}`);
  writeFileSync(dest, normalize(await res.text()));
  console.log(`synced from ${LIVE_URL}`);
}
