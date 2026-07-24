// Fails when the vendored openapi.json has fallen BEHIND the deployed live spec.
// `openapi:check` only compares the generated types to the vendored spec; this
// catches the vendored spec itself going stale. Run on a schedule.
//
// The test is directional: it fails only when the live spec carries surface the
// vendored copy is missing (a new path, operation, field, or enum value). A
// vendored copy that is AHEAD of live (changes merged but not yet deployed)
// passes quietly, so manual deploys never turn this red. A network failure is a
// soft pass (warn, exit 0) so a hiccup never cries wolf.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = join(root, 'openapi.json');
const LIVE_URL = 'https://api.beliq.eu/openapi.json';

/** Is every value in `live` present in `vendored`? (objects by key, arrays by element, scalars by equality). */
function coveredBy(live, vendored, path, missing) {
  if (Array.isArray(live)) {
    if (!Array.isArray(vendored)) {
      missing.push(path);
      return;
    }
    for (const item of live) {
      if (!vendored.some((cand) => isCovered(item, cand))) missing.push(`${path}[${JSON.stringify(item)}]`);
    }
    return;
  }
  if (live && typeof live === 'object') {
    if (!vendored || typeof vendored !== 'object' || Array.isArray(vendored)) {
      missing.push(path);
      return;
    }
    for (const key of Object.keys(live)) coveredBy(live[key], vendored[key], path ? `${path}.${key}` : key, missing);
    return;
  }
  if (live !== vendored) missing.push(path);
}

/** Boolean form used for array-element matching. */
function isCovered(live, vendored) {
  const missing = [];
  coveredBy(live, vendored, '', missing);
  return missing.length === 0;
}

let liveText;
try {
  const res = await fetch(LIVE_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
  liveText = await res.text();
} catch (err) {
  console.warn(`could not reach ${LIVE_URL} (${err.message}); skipping drift check`);
  process.exit(0);
}

const missing = [];
coveredBy(JSON.parse(liveText), JSON.parse(readFileSync(vendored, 'utf8')), '', missing);

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
