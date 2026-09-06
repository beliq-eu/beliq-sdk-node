import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A live generate or validate against the real engine takes several seconds,
    // well past vitest's 5s default. The integration suite never ran in CI, so
    // the default was never the thing that failed; it is now.
    testTimeout: 90_000,
  },
});
