// Fails when the vendored openapi.json has fallen BEHIND the deployed live spec.
// `openapi:check` only compares the generated types to the vendored spec; this
// catches the vendored spec itself going stale. Runs on every change and weekly.
//
// The comparison lives in `lib/spec-surface.mjs`, which explains what counts as
// surface and why values are never compared; `test/spec-surface.test.mjs` pins
// the behaviour in both directions. A network failure is a soft pass (warn,
// exit 0) so a hiccup never cries wolf.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { surfaceMissingFrom } from './lib/spec-surface.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = join(root, 'openapi.json');
const LIVE_URL = 'https://api.beliq.eu/openapi.json';

let liveText;
try {
  const res = await fetch(LIVE_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
  liveText = await res.text();
} catch (err) {
  console.warn(`could not reach ${LIVE_URL} (${err.message}); skipping drift check`);
  process.exit(0);
}

const missing = surfaceMissingFrom(
  JSON.parse(liveText),
  JSON.parse(readFileSync(vendored, 'utf8')),
);

if (missing.length === 0) {
  console.log('vendored openapi.json covers the live spec');
  process.exit(0);
}

console.error(
  `vendored openapi.json is behind the live spec (${missing.length} missing):\n` +
    missing.slice(0, 20).map((m) => `  - ${m}`).join('\n') +
    (missing.length > 20 ? `\n  ...and ${missing.length - 20} more` : '') +
    '\nRun `npm run sync:spec && npm run gen:types` and commit the result.',
);
process.exit(1);
