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
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { LIVE_PROFILES_BY_STANDARD } from '../src/constants.ts';

const engineRoot = process.env.BELIQ_ENGINE_PATH;
const enginePath = engineRoot ? resolve(engineRoot, 'app/routes/generate.py') : null;
const helpersPath = engineRoot ? resolve(engineRoot, 'app/versions.py') : null;

if (!enginePath || !helpersPath || !existsSync(enginePath) || !existsSync(helpersPath)) {
  console.error(
    (enginePath ? `no engine checkout at ${enginePath}.\n` : 'BELIQ_ENGINE_PATH is not set.\n') +
      'Set BELIQ_ENGINE_PATH to a checkout of the engine source. This check cannot run without the engine, ' +
      'and does not pass without running.',
  );
  process.exit(1);
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// Two rows of the table are calls (`"zugferd": zugferd_profile_keys()`): the
// engine projects both profile sets from the pinned Factur-X artifact rather
// than writing them out. Re-deriving the set here would add a third copy of the
// rule this check exists to compare, so the engine's own function is called
// instead, through the interpreter its checkout implies. The Python SDK's
// `scripts/check_profile_drift.py` resolves the same rows by importing the same
// module, so the two report the same table.
const PY_RESOLVE = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("beliq_engine_versions", sys.argv[1])',
  'module = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'resolver = getattr(module, sys.argv[2], None)',
  'if resolver is None: raise SystemExit(f"{sys.argv[1]} defines no {sys.argv[2]}")',
  'print(json.dumps(sorted(resolver())))',
].join('\n');

function engineHelper(standard, name) {
  let out;
  try {
    out = execFileSync('python3', ['-c', PY_RESOLVE, helpersPath, name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    fail(
      `${standard}: could not call ${name}() in ${helpersPath}: ` +
        `${(err.stderr || err.message).toString().trim()}`,
    );
  }
  const profiles = JSON.parse(out);
  if (!Array.isArray(profiles) || profiles.some((p) => typeof p !== 'string')) {
    fail(`${standard}: ${name}() resolved to ${out.trim()}, which is not a set of profile keys`);
  }
  return profiles;
}

const src = readFileSync(enginePath, 'utf8');
const block = src.match(/ALLOWED_PROFILES_FOR_STANDARD\s*=\s*\{\n([\s\S]*?)\n\}/);
if (!block) {
  fail(`could not find ALLOWED_PROFILES_FOR_STANDARD in ${enginePath}`);
}

// Every line of the table is read, and a line this script cannot read fails the
// run. The regex it replaced matched set literals only, so it skipped the two
// call rows in silence and compared them against a hardcoded profile list: the
// check reported eight standards checked while two of them were never read.
const table = {};
for (const line of block[1].split('\n')) {
  const row = line.trim();
  if (row === '' || row.startsWith('#')) continue;
  const parsed = row.match(/^"([^"]+)":\s*(.+?),?$/);
  if (!parsed) fail(`cannot read this row of ALLOWED_PROFILES_FOR_STANDARD: ${row}`);
  const [, standard, value] = parsed;
  const literal = value.match(/^\{((?:"[^"]+"(?:,\s*)?)+)\}$/);
  const call = value.match(/^([A-Za-z_][A-Za-z0-9_]*)\(\)$/);
  if (literal) {
    table[standard] = [...literal[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  } else if (call) {
    table[standard] = engineHelper(standard, call[1]);
  } else {
    fail(`${standard}: cannot resolve ${value}; teach this script about it`);
  }
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
      // Sorted, so this line is diffable against the Python SDK's twin.
      drift.push(
        `${standard}: "${profile}" is not in the engine's set [${[...allowed].sort().join(', ')}]`,
      );
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
