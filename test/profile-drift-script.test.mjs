import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LIVE_PROFILES_BY_STANDARD } from '../src/constants.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'check-profile-drift.mjs');

// The row the stand-in renders as a call rather than a set literal, so a run
// covers both shapes the engine uses.
const CALLED_STANDARD = 'zugferd';
const HELPER = `${CALLED_STANDARD}_profile_keys`;

/**
 * `scripts/check-profile-drift.mjs` must read the engine's table, or say it
 * cannot.
 *
 * The script compares LIVE_PROFILES_BY_STANDARD against the engine's
 * ALLOWED_PROFILES_FOR_STANDARD, and the engine's source is private, so CI
 * cannot run it against the real table. Its predecessor matched set literals
 * only, so it skipped the engine's two function-call rows in silence and
 * compared them against a profile list hardcoded in the script: it reported
 * eight standards checked while two of them were never read.
 *
 * These cases run it against a generated stand-in engine, so the resolution and
 * the comparison are covered in CI even though the real table is not. The
 * stand-in's rows are rendered FROM `LIVE_PROFILES_BY_STANDARD`, so nothing here
 * is a second copy of the engine's rule, and nothing here claims the real table
 * says anything in particular: that is what a run with BELIQ_ENGINE_PATH is for.
 */
function writeEngine(table, row) {
  const engine = mkdtempSync(join(tmpdir(), 'beliq-stand-in-engine-'));
  mkdirSync(join(engine, 'app', 'routes'), { recursive: true });

  const rows = Object.entries(table).map(([standard, profiles]) => {
    if (standard !== CALLED_STANDARD) {
      return `    "${standard}": {${profiles.map((p) => `"${p}"`).join(', ')}},`;
    }
    return `    "${standard}": ${row ?? `${HELPER}()`},`;
  });
  writeFileSync(
    join(engine, 'app', 'routes', 'generate.py'),
    `ALLOWED_PROFILES_FOR_STANDARD = {\n${rows.join('\n')}\n}\n`,
  );
  const called = [...table[CALLED_STANDARD]].sort();
  writeFileSync(
    join(engine, 'app', 'versions.py'),
    `def ${HELPER}():\n    return frozenset(${JSON.stringify(called)})\n`,
  );
  return engine;
}

function run(engine) {
  // A bare environment, so a BELIQ_ENGINE_PATH in the shell that runs vitest
  // cannot point these cases at the real engine.
  const env = { PATH: process.env.PATH };
  if (engine) env.BELIQ_ENGINE_PATH = engine;
  try {
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', script], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('check-profile-drift.mjs', () => {
  const standards = Object.keys(LIVE_PROFILES_BY_STANDARD).length;

  it('passes when every row resolves and covers the map', () => {
    const result = run(writeEngine(LIVE_PROFILES_BY_STANDARD));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${standards} standards checked`);
  });

  it('reports drift in a set literal row', () => {
    const result = run(
      writeEngine({ ...LIVE_PROFILES_BY_STANDARD, xrechnung: ['something-else'] }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('xrechnung: "xrechnung" is not in the engine');
  });

  it('reports drift in a row the engine resolves through a function', () => {
    // The shape the old regex skipped. A profile the engine's own helper does
    // not return has to read as drift, not as a pass.
    const [dropped, ...rest] = LIVE_PROFILES_BY_STANDARD[CALLED_STANDARD];
    const result = run(writeEngine({ ...LIVE_PROFILES_BY_STANDARD, [CALLED_STANDARD]: rest }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${CALLED_STANDARD}: "${dropped}" is not in the engine`);
  });

  it('reports a standard the engine has no row for', () => {
    const { ksef, ...table } = LIVE_PROFILES_BY_STANDARD;
    expect(ksef).toBeTruthy();
    const result = run(writeEngine(table));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ksef: the engine has no entry for this standard');
  });

  // Silence and a crash are the same failure from the repo's point of view: the
  // check reads as if it ran. Every unreadable row says what it is and exits
  // non-zero.
  it.each([
    ['invented_profile_keys()', 'defines no invented_profile_keys'],
    ['_SOME_CONSTANT', 'cannot resolve _SOME_CONSTANT'],
    ['zugferd_profile_keys("v2")', 'cannot resolve zugferd_profile_keys("v2")'],
    ['7', 'cannot resolve 7'],
  ])('fails loudly on a row it cannot read: %s', (row, expected) => {
    const result = run(writeEngine(LIVE_PROFILES_BY_STANDARD, row));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  it('fails rather than passing without an engine checkout', () => {
    expect(run(null).code).toBe(1);
    expect(run(mkdtempSync(join(tmpdir(), 'beliq-empty-'))).code).toBe(1);
  });
});
