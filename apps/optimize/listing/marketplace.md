# Crafthall Optimize – marketplace listing

## Short summary

Count your Claude Code token use, get ranked fixes to try (estimated, not measured), and measure one setup change with paired runs of your own tasks.

## Body

Crafthall Optimize looks at how your Claude Code setup uses tokens and helps you test a change before you keep it. Version 0.1.0, beta. Free, MIT licence.

**What it does**

- **See where your tokens go.** `usage` reads the usage fields of this repository's Claude Code session records (last 7 days by default) and shows totals by token kind, model, day, main conversation vs subagents, and your top sessions. The totals are counted from your records; the share behind each setup check is estimated, not measured.
- **Get ranked fixes.** Each fix names the evidence (`file:line`), the patch to write and a ready command to measure it. Every fix is labelled "estimated, not measured" (or "estimated, not measurable" when the effect is too small to detect).
- **Measure one change.** `compare` runs a few of your own tasks before and after the change, each run in a fresh git worktree, and reports the ratio with a 95% interval and pass counts from your own success command. On a subscription or usage-credits plan it judges token use by default; on API billing, cost. You see the planned runs and the expected cost first, and nothing runs until you confirm.

**How to read the results**

- A result says "measured on N runs of your fixtures"; everything else is "estimated, not measured".
- Every cost figure carries one label: API billing, API-equivalent estimate, subscription capacity or usage credits. Cost figures are Claude Code's client-side estimate; your bill may differ.
- On a Pro, Max or Ultra plan a saving is plan capacity, not money; it does not lower your subscription price.
- Every ratio comes with its 95% interval; when the interval contains 1.0 the verdict is "not enough evidence".
- On task success Optimize says at most "no drop larger than X pp detected on your success commands (N runs)".
- Comparisons run on your own Claude account and use your tokens or plan capacity; the expected cost is shown before anything runs.
- Results hold for your tasks, model and Claude Code version; re-measure after updates.

**Authentication**

Optimize runs your installed, unmodified `claude` command and never reads or stores your credentials. By default, comparison runs use your own API key (`ANTHROPIC_API_KEY`) with `claude --bare -p`. Your own Claude login is used only with `--auth subscription`; Optimize then tells you: "Runs count against your plan's limits; Anthropic's plan limits assume ordinary, individual use."

**Security note**

A fixture's success command runs the repository's code on your machine, and without `--bare` a `claude -p` session also starts the repository's hooks and MCP servers with no trust dialog. `fixture add` lists the hooks and MCP servers it finds; with `--auth subscription` such a fixture is refused unless you pass `--trust-fixture-config`. Add fixtures only from repositories whose code you trust.

**Data**

- **Read:** your repository's Claude Code config, the usage fields of this repository's session records under `~/.claude/projects/` (token counts, model ids, timestamps, ids, tool result sizes – never message text, tool output or file content), and the `/usage` rows you paste.
- **Stored:** only in `.crafthall/optimize/` in your repository, ignored by git: fixtures (commit id, salted prompt hash, success command, caps), comparison records and your billing setting. No prompt text, file content, secrets, credentials, absolute paths or identities.
- **Sent:** Optimize itself sends nothing to Crafthall or to any third party – no telemetry, no account, no network call of its own. The paired runs of `compare` are ordinary Claude Code runs on your own account: they send your prompts and the repository content Claude Code reads to Anthropic, or to your cloud provider, under your own terms with them. Run from the plugin, a command's output (token totals, ids, `file:line` evidence) becomes part of your Claude Code conversation and is sent to Anthropic like the rest of the session.

**Limits**

Beta. Small effects need many runs and often come back as "not enough evidence". Token counts come from Claude Code's records and are not a bill. Estimates, not advice or a guarantee of any saving.

**Support:** e-mail only – support@crafthall.dev.

Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
