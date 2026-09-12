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
