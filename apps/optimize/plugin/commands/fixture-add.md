---
description: Crafthall Optimize – freeze a task as a fixture (repository at a commit, prompt file as a salted hash, success command, caps)
argument-hint: "<name> --prompt <file> --check \"<cmd>\" [--commit <sha>] [--timeout-min <n>] [--max-budget-usd <n>]"
allowed-tools: Bash(node:*), Read
---

## Crafthall Optimize output

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/crafthall-optimize.mjs" --plugin fixture add $ARGUMENTS 2>&1; echo "crafthall-optimize exit code: $?"`

## Your task

Arguments the user typed: $ARGUMENTS

The output above comes from the Crafthall Optimize CLI bundled in this plugin. `fixture add` stores the fixture in
`.crafthall/optimize/fixtures/` of this repository (ignored by git): the commit id, a salted hash of the prompt file
(never its text), the success command and the caps. It runs no Claude Code session and spends nothing.

1. Start your answer with the first line of the output exactly as printed (it is the verdict line). Nothing before it.
2. Exit code 0: show the remaining lines as printed. If the output lists hooks or MCP servers of this repository, show
   that list as printed: the fixture's success command runs this repository's code, and with `--auth subscription` a
   comparison on such a fixture is refused unless the user passes `--trust-fixture-config`.
3. Exit code 2 is a usage error (for example a missing `--prompt` or `--check`, or a working tree that is not clean):
   show the error line and the usage hint as printed and stop. Any other non-zero exit code: show the error line and stop.

Do not edit any file and do not commit anything. Do not run `compare` from this command.
