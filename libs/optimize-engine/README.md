# @crafthall/optimize-engine

The one engine of Crafthall Optimize (one engine, two shells, HQ decoupled). Pure TypeScript, no dependencies, no Node built-ins, no network code; file I/O goes through the `StoreFs` port, so the CLI (`apps/optimize`) and a later Crafthall HQ tab use the same code.

- **Record schema v1** (`SCHEMA_VERSION`, `recordSchemaV1`; committed copy [`schema/record-v1.schema.json`](schema/record-v1.schema.json), JSON Schema 2020-12): fixtures and comparison records – versions, hashes (prompt file, config, diff, plugin list), repo-relative changed-file paths, arms, per-run metrics, exclusions, plan (MDE, expected cost, caps), result and verdict.
- `validateRecord(value)` → `SchemaError[]` (a small validator for the schema's keyword subset; an unsupported keyword throws).
- Privacy guard: `findPrivacyLeaks(value, { identities })`, `toRepoRelativePath(path, repoRoot)`; builders `createFixture`, `createComparisonRecord` hash content and relativize paths, then `assertStorable` (schema + privacy) – never stores prompt text, file content, secrets, absolute paths or identities.
- `sha256Hex`, `contentHash(content, salt?)` – plain-TypeScript SHA-256.
- Local store `<repo>/.crafthall/optimize/` (`STORE_DIR`, own `.gitignore`): `initStore`, `writeFixture`, `readFixture`, `listFixtures`, `removeFixture`, `ensureSalt` (per-store salt of prompt hashes, file `salt`), `writeComparison`, `readComparison`, `parseRecord`, `serializeRecord`.
- Fixture helpers (`fixtures.ts`): `FIXTURE_DEFAULTS`, `isFixtureName`, `parseCap`, `oracleToolCandidates` (allow-listed tools of a success command), `parseToolVersion`, `describeFixture`.

Tests: `npm test` at the repository root – schema accept/reject per required field, SHA-256 differential against `node:crypto`, privacy property tests (fast-check), store round-trip. All checks: `npm run verify`.
