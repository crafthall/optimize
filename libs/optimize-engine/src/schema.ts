// Record schema v1 of Crafthall Optimize (R0-02, validation §4.7): one JSON Schema (draft 2020-12) for the two record
// kinds the local store holds – a fixture (a frozen task) and a comparison record (one paired before/after run).
// The committed copy schema/record-v1.schema.json must equal this object (differential test in tests/schema.test.ts);
// external tools validate against the file, the engine against this object (validate.ts).
// Versioning (ADR-0001): `schemaVersion` is semver. A patch fixes wording only; a minor adds optional fields; a major
// changes or removes a field. An engine reads records of its own major with a minor up to its own.
// Privacy (legal note §1): no field holds prompt text, file content, tool output, secrets, absolute paths, user or host
// names, git identities or branch names. Free text is limited to the success command and the verdict text, both length
// capped and checked by the privacy guard (privacy.ts). `additionalProperties: false` everywhere, so nothing else can
// slip in.

export const SCHEMA_VERSION = '1.5.0';
/** 1.1.0: optional comparison field `auth` (the auth mode, never a secret); 1.0.0 records stay valid as they are. */
/** 1.2.0: optional comparison field `labels` (billing mode and cost label codes); older records stay valid. */
/** 1.3.0: optional `versions.modelByArm` (the pinned model of each arm); older records stay valid. */
/** 1.4.0: optional comparison field `stop` (why an incomplete record stopped); older records stay valid. */
/** 1.5.0: optional comparison field `metric` (tokens or cost; absent = cost) and optional run field `metrics.modelUsageTokens`; older records stay valid. */
export const SCHEMA_ID = 'urn:crafthall:optimize:record:v1';

const SEMVER = '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$';
/** Repo-relative POSIX path: no leading slash, no drive letter, no `~`, no `..` segment, no backslash. */
export const REPO_RELATIVE_PATH = '^(?![A-Za-z]:)(?!~)(?!/)(?!.*(^|/)\\.\\.(/|$))(?!.*\\\\)[^\\u0000-\\u001f]{1,512}$';

export const recordSchemaV1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: SCHEMA_ID,
  title: 'Crafthall Optimize record v1',
  description: 'A fixture or a comparison record of Crafthall Optimize, stored locally under <repo>/.crafthall/optimize/.',
  oneOf: [{ $ref: '#/$defs/fixture' }, { $ref: '#/$defs/comparison' }],
  $defs: {
    costLabel: { type: 'string', enum: ['api-billing', 'api-equivalent-estimate', 'subscription-capacity', 'usage-credits'], description: 'One of the four cost labels (#1033).' },
    schemaVersion: { type: 'string', pattern: '^1\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$', description: 'Semver of the record schema; major 1.' },
    semver: { type: 'string', pattern: SEMVER },
    timestamp: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$', description: 'UTC, ISO 8601.' },
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
    commit: { type: 'string', pattern: '^[0-9a-f]{40}([0-9a-f]{24})?$', description: 'Full git commit id (SHA-1 or SHA-256).' },
    hash: { type: 'string', pattern: '^sha256(-salted)?:[0-9a-f]{64}$', description: 'Hash of content that is never stored itself.' },
    repoPath: { type: 'string', pattern: REPO_RELATIVE_PATH, description: 'Repo-relative POSIX path.' },
    nonNegInt: { type: 'integer', minimum: 0 },
    usd: { type: 'number', minimum: 0, maximum: 100000 },
    arm: { type: 'string', enum: ['baseline', 'changed'] },
    passCount: {
      type: 'object',
      additionalProperties: false,
      required: ['passed', 'total'],
      properties: { passed: { $ref: '#/$defs/nonNegInt' }, total: { $ref: '#/$defs/nonNegInt' } },
    },
    fixture: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'kind', 'name', 'createdAt', 'commit', 'promptHash', 'check', 'caps', 'oracleTools'],
      properties: {
        schemaVersion: { $ref: '#/$defs/schemaVersion' },
        kind: { const: 'fixture' },
        name: { $ref: '#/$defs/name' },
        createdAt: { $ref: '#/$defs/timestamp' },
        commit: { $ref: '#/$defs/commit' },
        promptHash: { $ref: '#/$defs/hash' },
        promptFile: { $ref: '#/$defs/repoPath' },
        check: { type: 'string', minLength: 1, maxLength: 500, description: 'The success command; its exit code is the oracle.' },
        caps: {
          type: 'object',
          additionalProperties: false,
          required: ['timeoutMin', 'maxBudgetUsd'],
          properties: {
            timeoutMin: { type: 'number', exclusiveMinimum: 0, maximum: 240 },
            maxBudgetUsd: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
          },
        },
        oracleTools: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'version'],
            properties: { name: { type: 'string', pattern: '^[A-Za-z0-9@._/-]{1,64}$' }, version: { type: 'string', pattern: '^[0-9A-Za-z.+_-]{1,64}$' } },
          },
        },
      },
    },
    comparison: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'kind', 'id', 'createdAt', 'status', 'versions', 'hashes', 'change', 'fixtures', 'arms', 'plan', 'runs', 'exclusions', 'result', 'verdict'],
      properties: {
        schemaVersion: { $ref: '#/$defs/schemaVersion' },
        kind: { const: 'comparison' },
        id: { type: 'string', pattern: '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$', description: 'UTC start time plus 8 hex of the diff hash.' },
        createdAt: { $ref: '#/$defs/timestamp' },
        status: { type: 'string', enum: ['complete', 'incomplete'] },
        stop: {
          type: 'string',
          enum: ['run-cap', 'claude-code-version', 'interrupted', 'error'],
          description: 'Since 1.4.0 (#1131): why an incomplete record stopped. `interrupted` (Ctrl-C or a kill) caps the verdict at likely-saving.',
        },
        metric: {
          type: 'string',
          enum: ['tokens', 'cost'],
          description: 'Since 1.5.0 (#1165): what the verdict measures – token use per run or total_cost_usd. Absent = cost. result.costRatio and result.ci95 hold the ratio of this metric.',
        },
        auth: { type: 'string', enum: ['api-key', 'subscription'], description: 'How the runs authenticated (`compare --auth`, #1068; since 1.1.0). The mode only, never a key or token.' },
        labels: {
          type: 'object',
          additionalProperties: false,
          required: ['billing', 'measurementCost', 'saving'],
          description: 'Cost labels (#1033; since 1.2.0): the billing mode at compare time (`config set billing`) and the label of the measurement cost and of a saving.',
          properties: {
            billing: { type: 'string', enum: ['api', 'subscription', 'credits', 'unset'] },
            measurementCost: { $ref: '#/$defs/costLabel' },
            saving: { $ref: '#/$defs/costLabel' },
          },
        },
        versions: {
          type: 'object',
          additionalProperties: false,
          required: ['optimize', 'claudeCode', 'model'],
          properties: {
            optimize: { $ref: '#/$defs/semver' },
            claudeCode: { type: 'string', pattern: '^[0-9A-Za-z.+_ ()-]{1,64}$' },
            model: { type: 'string', pattern: '^[0-9A-Za-z.:@_-]{1,128}$', description: 'Resolved model id.' },
            effort: { type: 'string', pattern: '^[a-z]{1,16}$' },
            modelByArm: {
              type: 'object',
              additionalProperties: false,
              description: "Since 1.3.0 (#1130): the model of each arm's first counted run (since 1.4.0 each fixture of an arm pins its own model, #1131); an arm without a counted run is absent.",
              properties: {
                baseline: { type: 'string', pattern: '^[0-9A-Za-z.:@_-]{1,128}$' },
                changed: { type: 'string', pattern: '^[0-9A-Za-z.:@_-]{1,128}$' },
              },
            },
          },
        },
        hashes: {
          type: 'object',
          additionalProperties: false,
          required: ['config', 'diff', 'pluginList'],
          properties: { config: { $ref: '#/$defs/hash' }, diff: { $ref: '#/$defs/hash' }, pluginList: { $ref: '#/$defs/hash' } },
        },
        change: {
          type: 'object',
          additionalProperties: false,
          required: ['changedFiles'],
          properties: { changedFiles: { type: 'array', maxItems: 1000, items: { $ref: '#/$defs/repoPath' }, description: 'Repo-relative paths the change touches (R0-02; R2-04 links them to an agent or skill).' } },
        },
        fixtures: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'commit', 'promptHash'],
            properties: { name: { $ref: '#/$defs/name' }, commit: { $ref: '#/$defs/commit' }, promptHash: { $ref: '#/$defs/hash' } },
          },
        },
        arms: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['arm', 'configHash'],
            properties: { arm: { $ref: '#/$defs/arm' }, configHash: { $ref: '#/$defs/hash' } },
          },
        },
        plan: {
          type: 'object',
          additionalProperties: false,
          required: ['runsPerArm', 'cv', 'mde', 'expectedCostUsd', 'maxRuns', 'maxBudgetUsdPerRun'],
          properties: {
            runsPerArm: { type: 'integer', minimum: 1 },
            cv: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
            mde: { type: 'number', minimum: 0, maximum: 1, description: 'Planned minimum detectable effect as a fraction.' },
            expectedCostUsd: { $ref: '#/$defs/usd' },
            paybackMonths: { type: ['number', 'null'], minimum: 0 },
            maxRuns: { type: 'integer', minimum: 1 },
            maxBudgetUsdPerRun: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
          },
        },
        runs: {
          type: 'array',
          maxItems: 10000,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['seq', 'fixture', 'arm', 'oracleExitCode', 'metrics'],
            properties: {
              seq: { $ref: '#/$defs/nonNegInt' },
              fixture: { $ref: '#/$defs/name' },
              arm: { $ref: '#/$defs/arm' },
              oracleExitCode: { type: ['integer', 'null'], minimum: 0, maximum: 255 },
              metrics: {
                type: 'object',
                additionalProperties: false,
                required: ['inputTokens', 'cacheCreation5mTokens', 'cacheCreation1hTokens', 'cacheReadTokens', 'outputTokens', 'totalCostUsd', 'durationApiMs', 'model'],
                properties: {
                  inputTokens: { $ref: '#/$defs/nonNegInt' },
                  cacheCreation5mTokens: { $ref: '#/$defs/nonNegInt' },
                  cacheCreation1hTokens: { $ref: '#/$defs/nonNegInt' },
                  cacheReadTokens: { $ref: '#/$defs/nonNegInt' },
                  outputTokens: { $ref: '#/$defs/nonNegInt' },
                  totalCostUsd: { $ref: '#/$defs/usd' },
                  durationApiMs: { $ref: '#/$defs/nonNegInt' },
                  model: { type: 'string', pattern: '^[0-9A-Za-z.:@_-]{1,128}$' },
                  modelUsageTokens: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['input', 'cacheWrite', 'cacheRead', 'output'],
                    description: 'Since 1.5.0 (#1165): tokens summed over every model of modelUsage (cache write = 5m + 1h).',
                    properties: {
                      input: { $ref: '#/$defs/nonNegInt' },
                      cacheWrite: { $ref: '#/$defs/nonNegInt' },
                      cacheRead: { $ref: '#/$defs/nonNegInt' },
                      output: { $ref: '#/$defs/nonNegInt' },
                    },
                  },
                },
              },
            },
          },
        },
        exclusions: {
          type: 'array',
          maxItems: 10000,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['seq', 'reason'],
            properties: { seq: { $ref: '#/$defs/nonNegInt' }, reason: { type: 'string', enum: ['model-fallback', 'run-error', 'timeout', 'budget-cap'] } },
          },
        },
        result: {
          type: 'object',
          additionalProperties: false,
          required: ['costRatio', 'ci95', 'passes'],
          properties: {
            costRatio: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'Geometric-mean ratio changed ÷ baseline of the record metric (cost, or token use when metric is tokens); null when not computable.' },
            ci95: {
              oneOf: [{ type: 'null' }, { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', exclusiveMinimum: 0 } }],
            },
            passes: {
              type: 'object',
              additionalProperties: false,
              required: ['baseline', 'changed'],
              properties: { baseline: { $ref: '#/$defs/passCount' }, changed: { $ref: '#/$defs/passCount' } },
            },
          },
        },
        verdict: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'text'],
          properties: {
            code: { type: 'string', enum: ['measured-saving', 'likely-saving', 'not-enough-evidence'] },
            text: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
  },
} as const;
