---
description: Crafthall Optimize – paired before/after of one change; shows the plan and expected cost first and runs only after you confirm
argument-hint: "--change <patch-file> [--fixtures <a,b,c>] [--runs-per-arm <n>] [--max-runs <n>] [--max-budget-usd <n>] [--monthly-volume <usd>] [--auth <api-key|subscription>] [--metric <tokens|cost>] [--trust-fixture-config] [--force] [--json]"
allowed-tools: Bash(node:*), Read
disable-model-invocation: true
---

## Crafthall Optimize plan

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/crafthall-optimize.mjs" --plugin compare $ARGUMENTS 2>&1; echo "crafthall-optimize exit code: $?"`

## Your task

Arguments the user typed: $ARGUMENTS

The output above is the plan of the comparison, from the Crafthall Optimize CLI bundled in this plugin. A
plugin-started comparison always stops here: `--plugin compare` runs the CLI with `--plan-only` and drops any `--yes`,
so nothing was run and nothing was spent – also when the arguments contain `--yes`. The comparison runs only in step 3,
after the user confirms in this conversation.

1. Start your answer with the first line of the output exactly as printed (the plan's summary line). Nothing before
   it. Then show the plan block as printed: the runs, the smallest change it can detect, the expected cost with its
   label, the payback line and any note (billing mode, auth, hooks or MCP servers of the fixture repository).
2. Exit code 0: ask the user exactly one question – whether to run this comparison now, with the number of runs and the
   expected cost from the plan – and end your turn. Do not run anything else in this turn. If the plan says a spending
   run would be refused (payback horizon, `--auth subscription` with hooks or MCP servers, a set `ANTHROPIC_API_KEY` in
   subscription mode), say what the user would need to add and still ask. Exit code 2 is a usage error and 4 an
   environment error (for example `claude` not found): show the error line and stop; there is nothing to confirm.
3. Only when the user's next message clearly says yes to this plan, run the comparison with the Bash tool, with the
   same arguments as above minus any `--yes` or `--plan-only`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/crafthall-optimize.mjs" --plugin --confirmed compare <the same arguments> 2>&1; echo "crafthall-optimize exit code: $?"
   ```

   `--confirmed` is the user's yes; never add it, `--yes` or `--force` on your own, and never run the comparison when the
   user said no, asked a question or changed the arguments (then show the new plan with `/crafthall-optimize:compare`
   first). The runs take as long as the user's tasks take: give the Bash tool a timeout of 600000 ms, or run it in the
   background when the plan has more than a few runs, and tell the user it is running.
4. After the run, start your answer with the first line of its output exactly as printed (the verdict line), then the
   report as printed: the ratio with its 95% interval, the pass counts, what the measurement used, each figure with its
   cost label. Never shorten "not enough evidence" or "likely saving, not proven". Exit code 3 means a guard refused
   (show the `refused:` line); 5 means the run cap was reached or the run was interrupted (the record is incomplete).

Do not edit any file. Do not apply the change to the working copy: the comparison runs only in temporary worktrees.
