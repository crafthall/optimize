#!/usr/bin/env node
// Publish guard of Crafthall Optimize (R1-04; owner decision 2026-11-27: build release 1, publish nothing).
// Two locks stop an accidental `npm publish` of apps/optimize:
//   1. package.json has "private": true – npm refuses to publish it (`npm pack` still works, for the install E2E).
//   2. this script runs as `prepublishOnly` and fails unless CRAFTHALL_OPTIMIZE_PUBLISH_GO is exactly
//      "<name>@<version>" of this package – the explicit step the release (R1-05) takes only after the owner's go on
//      the publication issue (R1-16), and only after it has removed "private" from the manifest it publishes.
// No network, no account: it reads package.json and the environment only.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GO_ENV = 'CRAFTHALL_OPTIMIZE_PUBLISH_GO';

/** Why publishing must stop, or null when the explicit go matches this package. */
export function publishRefusal(pkg, env) {
  const id = `${pkg.name}@${pkg.version}`;
  if (env[GO_ENV] !== id) return `refusing to publish ${id}: set ${GO_ENV}=${id} only after the owner's publication go`;
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8'));
  const refusal = publishRefusal(pkg, process.env);
  if (refusal) {
    console.error(`publish-guard: ${refusal}`);
    process.exit(1);
  }
}
