---
description: Crafthall Optimize – re-print a stored comparison record; --redact gives a share-safe copy
argument-hint: "<record.json|id> [--redact] [--json]"
allowed-tools: Bash(node:*), Read
---

## Crafthall Optimize output

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/crafthall-optimize.mjs" --plugin report $ARGUMENTS 2>&1; echo "crafthall-optimize exit code: $?"`

## Your task

Arguments the user typed: $ARGUMENTS

The output above comes from the Crafthall Optimize CLI bundled in this plugin. It read one stored record and ran
nothing.

1. Start your answer with the first line of the output exactly as printed (it is the verdict line). Nothing before it.
2. Exit code 0: show the report as printed – the ratio with its 95% interval, the pass counts of each side and what
   the measurement itself used, every figure with its cost label. Never shorten a verdict: "not enough evidence" and
   "likely saving, not proven" stay as printed, and a result holds only for these fixtures, this model and this Claude
   Code version. With `--redact`, say that the copy should still be checked before it is shared.
3. Exit code 2 (no such record): show the error line and stop. Any other non-zero exit code: show the error line and stop.

Do not edit any file.
