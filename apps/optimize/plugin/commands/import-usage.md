---
description: Crafthall Optimize – ranked fixes from the /usage rows you saved to a file, plus checks of this repository's Claude Code config (estimated, not measured)
argument-hint: "--usage-file <file> [--read-transcripts <dir>] [--json]"
allowed-tools: Bash(node:*), Read
disable-model-invocation: true
---

## Crafthall Optimize output

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/crafthall-optimize.mjs" --plugin import-usage $ARGUMENTS 2>&1; echo "crafthall-optimize exit code: $?"`

## Your task

Arguments the user typed: $ARGUMENTS

The output above comes from the Crafthall Optimize CLI bundled in this plugin. A slash command cannot pass pasted text
on stdin, so the `/usage` rows come from the file given with `--usage-file`. The CLI stored nothing and sent nothing;
every fix is estimated, not measured.

1. Start your answer with the first line of the output exactly as printed (it is the verdict line). Nothing before it.
2. Exit code 0: show the ranked fixes as printed, each with its evidence and its ready command. Keep every label as
   printed; never turn an estimate into a promised saving. To measure a fix, offer `/crafthall-optimize:compare` with the
   fix's arguments (without `--plan-only`).
3. Exit code 2 (for example no `--usage-file` and no rows): show the error line, then tell the user in one sentence to
   copy the rows of Claude Code's `/usage` screen into a file in this repository and run
   `/crafthall-optimize:import-usage --usage-file <that file>`. Do not write the file yourself unless the user pasted the
   rows in this conversation and asks you to. Any other non-zero exit code: show the error line and stop.

Do not edit any other file. Do not run `compare` from this command.
