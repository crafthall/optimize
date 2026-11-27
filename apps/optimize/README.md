# Crafthall Optimize

Count the tokens your Claude Code sessions use, get a ranked list of fixes to try, and measure whether one setup change actually changed token use (or, on per-token billing, cost) while your own tasks still pass.

Version 0.1.0, beta. Free, MIT licence. Runs on your machine; works with or without Crafthall HQ.

## What it does

1. **`usage` – where your tokens go.** Reads the usage fields of this repository's Claude Code session records (the last 7 days by default) and prints the totals by token kind (uncached input, cache write, cache read, output), by model, by day, main conversation vs subagents, and your top sessions. Then it shows which share of those tokens sits behind each of six setup checks, with the `file:line` that triggered it. The totals are counted from your records; the shares behind the checks are estimated, not measured.
2. **Ranked fixes.** `usage` (and `import-usage`, which also takes the rows you copy from Claude Code's `/usage` screen) turns those findings into a ranked list of changes to try: what to change, the evidence, the patch to write and a ready `compare --plan-only` command. Every item is labelled "estimated, not measured" or, when the expected effect is too small for a comparison to detect, "estimated, not measurable".
3. **`compare` – measure one change.** Runs a few of your own tasks ("fixtures") before and after one change, interleaved, each run in a fresh git worktree, and reports the ratio with a 95% interval, pass counts for each side and what the measurement itself used. On a subscription or usage-credits plan the verdict is on token use by default; on API billing it is on cost. Before anything runs you see the plan: how many runs, the smallest change the plan can detect and the expected cost – and nothing starts until you confirm.

Optimize does not change your setup. You decide what to change; Optimize tells you what it found and what it measured.

Testing a plugin or a skill rather than your project's own setup? Claude Code's own tools fit that better: `claude plugin eval` ([Claude Code docs](https://code.claude.com/docs/en/plugin-evals), read 2026-11-27) and the skill-creator benchmark run with/without comparisons with graders. Optimize is for changes to your project's setup – CLAUDE.md, settings, model, effort, MCP servers, subagent models, hooks.

## Install

You need [Claude Code](https://code.claude.com/docs/en/overview), git and Node.js 20 or newer.

### Claude Code plugin

```bash
claude plugin marketplace add crafthall/plugins
claude plugin install crafthall-optimize@crafthall
```

Already in a session: `/plugin install crafthall-optimize --marketplace crafthall/plugins`, then `/reload-plugins`. The commands are then available in Claude Code under the `/crafthall-optimize:` prefix. A comparison started from the plugin also stops at the plan until you confirm.

### Command line (npx)

```bash
npx @crafthall/optimize --help
```

Run it inside the git repository whose Claude Code setup you want to look at. The examples below use the binary name `crafthall-optimize`; with npx, write `npx @crafthall/optimize` instead.

## Quick start (about 5 minutes, nothing spent)

These steps read your local files and spend no tokens.

1. **Tell Optimize how you pay** (stored once, in this repository only):

   ```bash
   crafthall-optimize config set billing subscription   # or: api, credits
   ```

   This decides how figures are labelled and whether `compare` judges token use or cost.

2. **See where your tokens went:**

   ```bash
   crafthall-optimize usage
   ```

   Use `--days 30` for a longer window, or `--read-transcripts <dir>` to read another folder (for example sessions started in a git worktree of this repository).

3. **Freeze one task you run often as a fixture.** Write the task prompt to a file, commit it, and name a command that tells whether the task succeeded:

   ```bash
   crafthall-optimize fixture add fix-login --prompt tasks/fix-login.md --check "npm test"
   ```

   Repeat for two or three tasks. Your working tree must be clean.

4. **Write the change you want to test as a patch**, for example a shorter `CLAUDE.md`:

   ```bash
   git diff > trim-claude-md.patch
   ```

5. **See the plan without running anything:**

   ```bash
   crafthall-optimize compare --change trim-claude-md.patch --plan-only
   ```

   The plan shows the runs, the smallest change it can detect, the expected cost and the payback horizon. `--plan-only` spends nothing and needs no API key.

When you are ready to measure, run the same command without `--plan-only`. The runs take as long as your tasks take, and they use your tokens or plan capacity (see [Authentication](#authentication) and [Data](#data)).

## Commands

| Command | What it does |
|---|---|
| `usage [--days <n>] [--read-transcripts <dir>] [--usage-file <file\|->] [--json]` | Token use of this repository's Claude Code sessions (last 7 days by default), the share behind each check (estimated, not measured) and ranked fixes. Stores nothing. |
| `import-usage [--usage-file <file>] [--read-transcripts <dir>] [--json]` | Ranked fixes from the `/usage` rows you paste (stdin or file) plus Optimize's own checks of your config. Reads session records only with `--read-transcripts`. Stores nothing. |
| `fixture add <name> --prompt <file> --check "<cmd>" [--commit <sha>] [--timeout-min <n>] [--max-budget-usd <n>]` | Freeze a task: the repository at a commit, the prompt file (stored as a salted hash only), the success command, time and budget caps. |
| `fixture list [--json]` / `fixture remove <name> [--json]` | Show or delete fixtures. |
| `config set billing <api\|subscription\|credits>` | Store how you pay; drives the labels and the default `compare` metric. |
| `compare --change <patch-file> [--fixtures <a,b,c>] [--runs-per-arm <n>] [--max-runs <n>] [--max-budget-usd <n>] [--monthly-volume <usd>] [--auth <api-key\|subscription>] [--metric <tokens\|cost>] [--trust-fixture-config] [--plan-only] [--yes] [--force] [--json]` | Paired before/after of one change. Prints the plan first and asks before any run. |
| `report <record.json\|id> [--redact] [--json]` | Re-print a stored comparison. `--redact` gives a copy without commit ids, fixture names or other details of your repository, for sharing. |
| `--version`, `--help` | Version and usage. |

Defaults for `compare`: 4 runs per task and side, at most 60 runs per comparison, a per-run budget cap from each fixture (`--max-budget-usd`, default USD 0.50 per run), `--auth api-key`. The metric is `tokens` when billing is `subscription` or `credits` and `cost` when billing is `api` or not set; `--metric` overrides it.

The first line of every output is the verdict. `--json` prints the same content as JSON.

## How to read the results

These rules hold for every figure Optimize prints, and for this page.

- **Measured or estimated.** A result from `compare` says "measured on N runs of your fixtures". Everything else – the shares in `usage`, the fixes in `import-usage` – is "estimated, not measured" (or "estimated, not measurable"). A bare percentage is never a result.
- **What a figure means for your bill.** Every cost figure carries one of four labels: API billing, API-equivalent estimate, subscription capacity or usage credits. Cost figures are Claude Code's client-side estimate; your bill may differ.
- **Subscriptions.** On a Pro, Max or Ultra plan a saving is plan capacity, not money; it does not lower your subscription price.
- **Model changes.** When the two arms ran different models on a subscription or with usage credits, the saving is shown as an API-equivalent estimate: Anthropic does not publish how plan limits weight models, so no plan-capacity saving is claimed.
- **Uncertainty.** Every ratio comes with its 95% interval. When the interval contains 1.0, the verdict is "not enough evidence". The other verdicts are "likely saving, not proven" and "measured saving".
- **Task success.** Optimize reports pass counts for each side and, at most, "no drop larger than X pp detected on your success commands (N runs)" (pp = percentage points of the pass rate). Your success command is the only signal of task success; Optimize makes no wider claim about quality.
- **The cost of measuring.** Comparisons run on your own Claude account and use your tokens or plan capacity; the expected cost is shown before anything runs. A comparison whose payback horizon is over 3 months, or cannot be computed (without `--monthly-volume`, your monthly spend in USD), does not start unless you add `--force`.
- **Scope.** Results hold for your tasks, model and Claude Code version; re-measure after updates.

## Case study: one model change on three small tasks

Measured by us, the makers of Crafthall Optimize, on tasks from our own repository (24 runs, 2026-11-27, Claude Code 2.1.332). Your results will differ.

This shows what a measurement looks like; it is not advice to change models. The change: the model set in `.claude/settings.json`, Opus 5.5 → Sonnet 5.5. Three small, bounded coding tasks from our own repository, 4 runs per task and side, interleaved, metric: cost.

Verdict line as printed (API-equivalent cost at list prices, not money paid or plan capacity saved): `Measured saving of 51%: cost ratio 0.488 (95% CI 0.456–0.522), measured on 24 runs of your fixtures.`

| Figure | Result |
|---|---|
| Runs per side | 12 Opus 5.5, 12 Sonnet 5.5 |
| Success command passed | Opus 11 of 12, Sonnet 12 of 12 |
| Cost ratio, Sonnet ÷ Opus (API-equivalent estimate) | 0.488 (95% interval 0.456–0.522) |
| Token ratio, Sonnet ÷ Opus (secondary) | 0.935 |

- **Where the lower cost comes from.** Almost all of it is the per-token price: Sonnet 5.5 lists at half the price of Opus 5.5 on every token type (Anthropic's published API price list on platform.claude.com, read 2026-11-27), while token use fell only about 6.5%. Cost figures are Claude Code's client-side estimate at API list prices; your bill may differ.
- **Subscription.** The runs used subscription capacity, so the USD figures are API-equivalent, not money paid. Anthropic does not publish how plan limits weight models, so we claim no plan-capacity saving.
- **Task success.** No drop larger than 25 pp detected on the success commands (12 runs per side). This cannot show that quality is equal.
- **The per-run cap.** The USD 0.50 cap gave Opus less room: 3 of 27 Opus runs across both phases hit it and count as fails.
- **Cost of measuring.** USD 7.70 for these 24 runs; USD 17.30 for all 54 runs including a 30-run pilot (API-equivalent estimate, run on subscription capacity).
- **Not tested.** Long sessions and other kinds of work.

## Authentication

`compare` runs your installed, unmodified `claude` command. Optimize never reads, copies or stores your credentials, tokens or keychain entries, never offers a login and never runs anything on our keys.

- **Default: your API key.** Set `ANTHROPIC_API_KEY` in your environment. Runs use `claude --bare -p`, so Claude Code authenticates only with that key and does not start the fixture repository's hooks or MCP servers. The runs are billed to that key's API account. Optimize checks only that the variable is set; it never reads the value into a record, an output or a log.
- **Your own Claude login, only if you ask for it:** `--auth subscription`. Optimize then prints: "Runs count against your plan's limits; Anthropic's plan limits assume ordinary, individual use." If `ANTHROPIC_API_KEY` is also set, Optimize refuses to start, because `claude -p` would bill the runs to that key instead of your plan.

## Security note: fixtures run code

A fixture replays a task in a copy of a repository, and its success command runs that repository's code on your machine. Without `--bare`, a `claude -p` session also starts the repository's hooks and MCP servers with no trust dialog.

- `fixture add` lists the hooks and MCP servers it finds in `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`. Only these files are checked; the settings `env` block and helper commands also apply.
- In the default API-key mode, runs use `--bare`, which does not start hooks or MCP servers. `--bare` is not a sandbox: the success command still runs the repository's code.
- With `--auth subscription`, a comparison on a fixture with hooks or MCP servers is refused unless you pass `--trust-fixture-config`.

Add fixtures only from repositories whose code you trust.

## Data

**What Optimize reads**

- Your repository's Claude Code config: `CLAUDE.md` files, `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, rules, agents, commands and skills, and the test command in files such as `package.json`. It does not read your user-level config in `~/.claude/`.
- Session records, as usage fields only: token counts, model ids, timestamps, request and session ids, whether a request came from a subagent, and the size of tool results. `usage` reads this repository's own folder under `~/.claude/projects/`, or the folder you name with `--read-transcripts`. `import-usage` reads session records only when you pass `--read-transcripts`. Records are read one file at a time and reduced to these fields at once; message text, tool input and output, and file content are not kept.
- The `/usage` rows you paste, and the prompt file and success command you give `fixture add`.

**What Optimize stores, and where**

Only in `.crafthall/optimize/` inside your repository. The folder has its own `.gitignore`, so git ignores it, and its files are readable by your user only.

- Fixtures: the commit id, a salted hash of the prompt file (never its text), the prompt file's path inside the repository, the success command, the caps, the versions of the tools the success command uses, the creation time.
- Comparison records: versions, hashes of the config and the change, the runs' token counts, cost estimates, durations and pass or fail, exclusions, the plan, the result and the verdict text.
- `config.json` (your billing mode) and the salt for the hashes.

Optimize never stores prompt text, tool output, file content, secrets, credentials, absolute paths, user or host names, git author names or e-mails, or branch names. `usage` and `import-usage` store nothing. Delete the folder to remove everything.

**What is sent, and to whom**

- **Optimize itself sends nothing to Crafthall or to any third party.** It has no telemetry, no account and makes no network call of its own.
- **The paired runs of `compare` are ordinary Claude Code runs** on your own account. Like any Claude Code session, they send your prompts and the repository content Claude Code reads to Anthropic, or to your cloud provider if you use Claude Code through one, under your own terms with them. `usage`, `import-usage`, `fixture`, `config` and `report` start no Claude Code runs.
- **Plugin commands put their output into your conversation.** When you run an Optimize command from the Claude Code plugin, what it prints (token totals, model ids, session ids, `file:line` evidence, fixture names) becomes part of that Claude Code conversation and is sent to Anthropic, or to your cloud provider, like everything else in the session. Run from a terminal, the output stays on your screen.
- To share a result, use `report --redact`, and check the copy before you share it.

## Limits

- **Beta.** Version 0.1.0; commands and output may change.
- **Small effects need many runs.** A short comparison detects only large changes; smaller ones come back as "not enough evidence". The plan shows the smallest change your plan can detect before anything runs.
- **Token counts are not a bill.** They come from Claude Code's own records. The token metric adds input, cache write, cache read and output tokens at equal weight. Anthropic does not publish how subscription or credit limits weigh these kinds, so a lower token count does not tell you exactly how much plan capacity you get back.
- **The estimates in `usage` overlap and are rough.** The checks overlap, so their shares do not add up; some count too little (MCP tool lists, the system prompt) and some may count too much (compacted output). Only `compare` measures.
- **Session records are not a documented format.** Unknown or broken lines are counted and skipped. Claude Code deletes old records (after 30 days by default), so a longer `--days` window may find less.
- **Fixtures need a working baseline.** Runs start in a fresh worktree of the pinned commit, so only committed files are there: commit the permission settings the task needs, and let the success command install or build what it needs. A task whose baseline fails measures nothing.
- **A Claude Code update during a comparison stops it**; the runs done so far are kept as an incomplete record. Your own working copy is never touched; runs happen only in temporary worktrees.
- **Not advice.** Optimize gives estimates and measurements, not advice or a guarantee of any saving.

## Support

Support: e-mail only – [support@crafthall.dev](mailto:support@crafthall.dev). Include the command you ran, the first line of its output and `crafthall-optimize --version`. Do not send prompt text, secrets or unredacted records.

## Licence

MIT.

---

Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
