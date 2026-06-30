// Refreshes the vendored openapi.json. Prefers a sibling beliq-api checkout
// (../../beliq-api/openapi.json), falls back to fetching the live spec. The
// vendored copy is committed so builds stay reproducible; run this only when
// the API surface changes, then `npm run gen:types` and commit both.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'openapi.json');
const sibling = join(root, '..', '..', 'beliq-api', 'openapi.json');
const LIVE_URL = 'https://api.beliq.eu/openapi.json';

function normalize(text) {
  // Re-serialize so a trailing-newline / formatting difference never shows as drift.
  return JSON.stringify(JSON.parse(text), null, 2) + '\n';
}

if (existsSync(sibling)) {
  writeFileSync(dest, normalize(readFileSync(sibling, 'utf8')));
  console.log(`synced from ${sibling}`);
} else {
  const res = await fetch(LIVE_URL);
  if (!res.ok) throw new Error(`fetch ${LIVE_URL} failed: ${res.status}`);
  writeFileSync(dest, normalize(await res.text()));
  console.log(`synced from ${LIVE_URL}`);
}
