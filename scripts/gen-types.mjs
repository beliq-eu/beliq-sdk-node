// Regenerates src/generated/schema.ts from the vendored openapi.json.
// With `--check` it regenerates into a temp file and diffs against the committed
// output, failing if they differ (the CI drift guard; mirrors beliq-api's
// `openapi:check`). Run `npm run gen:types` and commit when it complains.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = join(root, 'openapi.json');
const out = join(root, 'src', 'generated', 'schema.ts');
const check = process.argv.includes('--check');

function generate(target) {
  execFileSync('npx', ['--no-install', 'openapi-typescript', spec, '-o', target], {
    stdio: ['ignore', 'ignore', 'inherit'],
    cwd: root,
  });
}

if (!check) {
  generate(out);
  console.log(`wrote ${out}`);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'beliq-types-'));
  const tmp = join(dir, 'schema.ts');
  try {
    generate(tmp);
    const fresh = readFileSync(tmp, 'utf8');
    const committed = readFileSync(out, 'utf8');
    if (fresh !== committed) {
      console.error('src/generated/schema.ts is stale. Run `npm run gen:types` and commit the result.');
      process.exit(1);
    }
    console.log('src/generated/schema.ts is in sync with openapi.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
