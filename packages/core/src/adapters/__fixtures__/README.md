# Adapter fixtures

`codex-real-stream.jsonl` is a **real** capture from `codex exec --json` on
codex-cli 0.147.0, taken 2026-09-12. It is the evidence behind the Codex
adapter's event mapping, and the reason that mapping was rewritten: the
schema the adapter originally guessed at (`session_configured`,
`agent_message`, `task_complete`) does not exist. The real envelope is
`thread.started` / `turn.started` / `item.completed` / `turn.completed` /
`turn.failed` / `error`.

The captured turn fails, because the account's configured model requires a
newer CLI. That does not weaken it as a fixture: every envelope event CAPO
depends on for session startup appears in it, and `thread.started` in
particular is what the adapter must see to consider a session ready.

Item types other than `error` are still inferred. A successful turn has not
been captured.

## claude-real-stream.jsonl / claude-real-toolcall.jsonl

Real captures from `claude -p --output-format stream-json --input-format
stream-json` on Claude Code 2.1.236, taken 2026-09-13 in a throwaway repo
(never against this project). Absolute home-directory paths and this
machine's installed-plugin/skill inventory have been scrubbed and trimmed;
every distinct message shape from the live run survives.

`claude-real-stream.jsonl` is a two-turn session: turn one asks the model to
repeat a codeword that appears only in `--append-system-prompt` (proving the
system prompt is actually delivered), turn two is a `send()` follow-up on the
same process. It also captures a real surprise: the CLI re-emits
`system`/`init` (carrying the same session id) before the second turn, not
just once at startup — the adapter originally would have queued a spurious
second `ready` event for that.

`claude-real-toolcall.jsonl` captures a turn where the model actually calls
the `Bash` tool and gets a real tool result back before replying — the
evidence for the `tool_use` block shape, and for the finding that
`--permission-mode acceptEdits` in `-p` mode auto-approves tool calls rather
than stalling on approval (unlike a live Codex run).

Both captures also show the real usage-limit signal: a top-level
`rate_limit_event` with `rate_limit_info: { status: "allowed" |
"allowed_warning" | "rejected", resetsAt, rateLimitType }`, not prose in
assistant text. Both captures only ever have `status: "allowed"` — this
account never hit a limit — so the `"rejected"` mapping in `claude.ts` is
evidence-based (the schema was extracted from the installed CLI binary) but
not confirmed end-to-end by a triggered live event.
