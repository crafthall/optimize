---
description: Crafthall Optimize – count this repository's Claude Code token use (last 7 days by default) and rank fixes to try (estimated, not measured)
argument-hint: "[--days <n>] [--read-transcripts <dir>] [--usage-file <file>] [--json]"
allowed-tools: Bash(node:*), Read
disable-model-invocation: true
---

## Crafthall Optimize output

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/crafthall-optimize.mjs" --plugin usage $ARGUMENTS 2>&1; echo "crafthall-optimize exit code: $?"`

## Your task

Arguments the user typed: $ARGUMENTS

The output above comes from the Crafthall Optimize CLI bundled in this plugin. It read only the usage fields of this
repository's Claude Code session records and its Claude Code config, stored nothing and sent nothing. The token totals
are counted from the records; the shares behind the checks and the fixes are estimated, not measured.

1. Start your answer with the first line of the output exactly as printed (it is the verdict line). Nothing before it.
2. Exit code 0: show the totals and the ranked fixes as printed, each with its evidence (`file:line`) and its ready
   command. Keep every label ("estimated, not measured", "estimated, not measurable", the cost labels) as printed; never
   turn an estimate into a promised saving. A fix's measuring command is a `compare --plan-only` command: offer
   `/crafthall-optimize:compare` with the same arguments (without `--plan-only`) to see the plan of that measurement.
3. Exit code 2 is a usage error (for example a bad `--days`, or no session records): show the error line and the
   usage hint as printed and stop. Any other non-zero exit code: show the error line and stop.

Do not edit any file. Do not run `compare` from this command.
