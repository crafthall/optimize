# Session-record fixtures (import-usage)

Synthetic Claude Code session records shaped after the record keys observed in local transcripts of Claude Code
2.1.321, 2.1.326 and 2.1.330 on 2026-11-26 (keys only were inspected; no real content was copied). Each file holds
one main conversation of 8 requests with idle gaps of under 5, 5–60 and over 60 minutes, assistant messages split
into one record per content block with a shared `requestId`, Bash and Read tool results (large and small), record
types the reader does not know, and one malformed line. Message text, tool input and tool output carry sentinel
strings (a fake API key, a fake absolute path, a fake identity) that the reader must never return.

- `v2.1.321.jsonl`: no `usage.cache_creation` TTL split; tool results as plain strings.
- `v2.1.326.jsonl`: 5-minute TTL split; tool results as text-block arrays.
- `v2.1.330.jsonl`: 1-hour TTL split; extra fields (`attributionSkill`, `promptCacheRequested`, `effort`).

Regenerate only if the reader's expectations change; the tests pin the counts.
