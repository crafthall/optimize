<!-- The CLI contract (commands, flags, defaults, exit codes). test/contract.test.ts checks the CLI against these tables. -->
## 4. CLI interface

Working binary name `crafthall-optimize`. Every command runs on the user's machine and makes no network call of its own; the only outbound traffic is the user's own `claude -p` child processes during `compare`.

| Command | Purpose | Key flags | Output |
|---|---|---|---|
| `fixture add <name>` | Freeze a task: repo at a commit, prompt file, success command, caps | `--prompt <file>` (required), `--check "<cmd>"` (required), `--commit <sha>` (default `HEAD`), `--timeout-min <n>` (default 15), `--max-budget-usd <n>` (default 0.50) | One fixture entry (prompt **hash** only); prints the security note of R0-13 if the repo has hooks or MCP servers |
| `fixture list` / `fixture remove <name>` | Inspect or delete fixtures | `--json` | Table or JSON |
| `config set billing <api\|subscription\|credits>` | Billing mode asked once, stored locally; drives the cost label | – | Confirmation line |
| `import-usage` | Hypotheses from pasted `/usage` rows and the non-native checks D2, D3, D5, D6 | `--usage-file <file>` or stdin; `--read-transcripts <dir>` (opt-in, R0-03); `--otel <file>` (moved to r1 R1-18, exits 2 "not built yet" in release 0); `--json` | Ranked candidate list, each "estimated, not measured" or "estimated, not measurable" |
| `usage` | Token usage of this repo's Claude Code sessions and ranked fixes | `--read-transcripts <dir>` (instead of this repo's folder under `~/.claude/projects/`), `--days <n>` (default 7), `--usage-file <file\|->` (optional `/usage` rows), `--json` | Totals by component, model, day, main vs subagents and top sessions; the share behind D1–D6; ranked fixes, each "estimated, not measured" or "estimated, not measurable" |
| `compare` | Paired before/after of one change | `--change <patch-file>` (required), `--fixtures <a,b,c>` (default all), `--runs-per-arm <n>` (default 4 per task), `--cv <x>` (default 0.30, labelled assumption), `--monthly-volume <amount>`, `--max-budget-usd <n>` (per run, default 0.50), `--max-runs <n>` (per comparison, default 60), `--auth <api-key\|subscription>` (default `api-key`, R0-12), `--metric <tokens\|cost>` (by billing mode: `tokens` for subscription or credits, `cost` for api or unset; R1-19), `--trust-fixture-config` (R0-13), `--plan-only`, `--yes`, `--force`, `--json` | Plan block first (planned MDE, expected cost, payback horizon), then the report and one JSON record |
| `report <record.json>` | Re-print a stored record; share-safe export | `--redact`, `--json` | Report text or redacted JSON |
| `--version`, `--help` | Version line and usage | – | Text |

**Output rules:** the first line is the verdict (for `compare`: "measured saving …", "likely saving, not proven" or "not enough evidence"); human text by default, `--json` gives the same content as JSON. Record-carrying `--json` outputs (`compare`, `report`, `report --redact`, `fixture list`, `fixture remove`) are validated against the record schema. Three `--json` outputs store nothing and are **non-record outputs** outside the record schema, each with its own `kind` and `format` and a shape pinned by the contract E2E: `import-usage --json` (`kind: crafthall-optimize/hypotheses`, `format: 1`), `compare --plan-only --json` (`kind: crafthall-optimize/plan`, `format: 1`, the plan under `plan`) and, from r1, `usage --json` (`kind: crafthall-optimize/token-usage`, `format: 1`, validated against `tokenUsageSchemaV1`); a change to any of these shapes bumps its `format`; every cost figure carries one of the four labels (R0-11).

**Run minimums:** a comparison can produce an interval only with `--runs-per-arm ≥ 2` and `--max-runs ≥ 4 × tasks` (every task needs at least 2 runs in each arm under the interleaved schedule). The flag parser rejects `--max-runs` below 2 (exit 2; the task count is known only after the fixtures load); the plan checks the real minimum and, when it is not met, prints "planned MDE: none" with the minimum and refuses without `--force` (exit 3).

**Spending guard:** `compare` always prints the plan and asks "Proceed? (y/N)" before the first run; with no terminal and no `--yes` it refuses. A payback horizon over 3 months refuses without `--force`; an expected cost over `--max-runs × --max-budget-usd` is impossible by construction.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Command completed (any verdict, including "not enough evidence") |
| 1 | Internal error (bug) |
| 2 | Usage error: unknown flag, missing fixture, invalid patch, schema-invalid input |
| 3 | Refused by a guard: payback > 3 months without `--force`, user declined, no terminal and no `--yes`, `--auth subscription` on a fixture with hooks or MCP servers without `--trust-fixture-config` (R0-13), `--auth subscription` with `ANTHROPIC_API_KEY` set (the key would pay) |
| 4 | Environment error: `claude` not found, version changed mid-comparison (restart required), auth missing for the chosen `--auth`, git failed or timed out (120 s limit). After at least one completed run the runs done so far are stored as an `incomplete` record first and the message names the cause and the record |
| 5 | Run cap reached or interrupted before the plan completed: partial record written and labelled "incomplete". Interrupted = Ctrl-C (SIGINT or SIGTERM reaching the running child) or SIGINT/SIGTERM sent to the CLI alone (`kill <pid>`): scheduling stops, the interrupted run is neither stored nor counted, every `crafthall-optimize-run-*` worktree is removed, the record says `stop: "interrupted"` and its verdict is at most "likely saving"; an interrupt before the first run (replay check) stores nothing |

## 5. End
