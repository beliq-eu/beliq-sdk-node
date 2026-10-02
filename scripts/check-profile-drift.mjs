// Fails when LIVE_PROFILES_BY_STANDARD offers a (standard, profile) pair the
// engine would answer with 422 PROFILE_STANDARD_MISMATCH.
//
// The map is a client-side copy of a rule only the engine holds, so it can drift
// silently: nothing in the vendored spec expresses the pairing (the OpenAPI
// `profile` enum is flat), and a wrong pair surfaces as a 422 in a user's flow
// rather than as a red build. This reads the engine's own table.
//
// It needs a checkout of the engine's source, named by BELIQ_ENGINE_PATH, and
// EXITS NON-ZERO without one, rather than passing quietly: a check that reports
// success when it did not run is worse than no check. The engine's source is
// not public, so this does not belong in CI. Run it whenever the map or the engine's table changes.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIVE_PROFILES_BY_STANDARD } from '../src/constants.ts';

const engineRoot = process.env.BELIQ_ENGINE_PATH;
const enginePath = engineRoot ? resolve(engineRoot, 'app/routes/generate.py') : null;

if (!enginePath || !existsSync(enginePath)) {
  console.error(
    (enginePath ? `no engine checkout at ${enginePath}.\n` : 'BELIQ_ENGINE_PATH is not set.\n') +
      'Set BELIQ_ENGINE_PATH to a checkout of the engine source. This check cannot run without the engine, ' +
      'and does not pass without running.',
  );
  process.exit(1);
}

const src = readFileSync(enginePath, 'utf8');

// `_FACTURX_PROFILES` is projected from the pinned Factur-X artifact at import
// time, so it is not a literal in the file. Resolve it the same way the engine
// documents: the Factur-X profile set, with ZUGFeRD dropping extended-ctc-fr.
const FACTURX = ['minimum', 'basicwl', 'basic', 'en16931', 'extended', 'extended-ctc-fr'];

const table = { facturx: FACTURX, zugferd: FACTURX.filter((p) => p !== 'extended-ctc-fr') };

const block = src.match(/ALLOWED_PROFILES_FOR_STANDARD\s*=\s*\{([\s\S]*?)\n\}/);
if (!block) {
  console.error(`could not find ALLOWED_PROFILES_FOR_STANDARD in ${enginePath}`);
  process.exit(1);
}
for (const [, standard, values] of block[1].matchAll(/"([^"]+)":\s*\{([^}]*)\}/g)) {
  table[standard] = [...values.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const drift = [];
for (const [standard, profiles] of Object.entries(LIVE_PROFILES_BY_STANDARD)) {
  const allowed = table[standard];
  if (!allowed) {
    drift.push(`${standard}: the engine has no entry for this standard`);
    continue;
  }
  for (const profile of profiles) {
    if (!allowed.includes(profile)) {
      drift.push(`${standard}: "${profile}" is not in the engine's set [${allowed.join(', ')}]`);
    }
  }
}

if (drift.length > 0) {
  console.error(
    'LIVE_PROFILES_BY_STANDARD offers pairs the engine rejects:\n' +
      drift.map((d) => `  - ${d}`).join('\n'),
  );
  process.exit(1);
}

console.log(
  `LIVE_PROFILES_BY_STANDARD is a subset of the engine's table ` +
    `(${Object.keys(LIVE_PROFILES_BY_STANDARD).length} standards checked)`,
);
