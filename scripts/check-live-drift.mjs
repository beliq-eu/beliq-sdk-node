// Fails when the vendored openapi.json disagrees with the deployed live spec.
// `openapi:check` only compares the generated types to the vendored spec; this
// catches the vendored spec itself going stale. Runs on every change and weekly.
//
// Two questions, both from `lib/spec-surface.mjs`, which explains what counts as
// surface and why no other value is compared; `test/spec-surface.test.mjs` pins
// the behaviour in both directions:
//
//   - missing surface: a path, field or enum value the live spec has and the
//     vendored copy lacks. Directional, so a copy legitimately ahead of the
//     deploy is silent.
//   - diverging descriptions: text the two documents do not spell identically,
//     in either direction, because prose carries no direction.
//
// A network failure is a soft pass (warn, exit 0) so a hiccup never cries wolf.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { descriptionsDiverging, surfaceMissingFrom } from './lib/spec-surface.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = join(root, 'openapi.json');
const LIVE_URL = 'https://api.beliq.eu/openapi.json';
const SHOWN = 20;

let liveText;
try {
  const res = await fetch(LIVE_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
  liveText = await res.text();
} catch (err) {
  console.warn(`could not reach ${LIVE_URL} (${err.message}); skipping drift check`);
  process.exit(0);
}

const live = JSON.parse(liveText);
const vend = JSON.parse(readFileSync(vendored, 'utf8'));

const missing = surfaceMissingFrom(live, vend);
const diverging = descriptionsDiverging(live, vend);

if (missing.length === 0 && diverging.length === 0) {
  console.log('vendored openapi.json covers the live spec, descriptions included');
  process.exit(0);
}

const listing = (entries) =>
  entries.slice(0, SHOWN).map((entry) => `  - ${entry}`).join('\n') +
  (entries.length > SHOWN ? `\n  ...and ${entries.length - SHOWN} more` : '');

if (missing.length > 0) {
  console.error(
    `vendored openapi.json is behind the live spec (${missing.length} missing):\n` +
      listing(missing),
  );
}
if (diverging.length > 0) {
  console.error(
    `vendored openapi.json and the live spec disagree on ${diverging.length} description(s):\n` +
      listing(diverging),
  );
}
console.error(
  'Run `npm run sync:spec && npm run gen:types` and commit the result. A description the ' +
    'vendored copy carries and the live spec does not can also mean the spec change it was ' +
    'synced from is merged but not deployed yet.',
);
process.exit(1);
