# Codex: what a live run actually showed

Recorded 2026-09-12 by running `codex exec --json` against a real account on
codex-cli 0.147.0, after the Codex adapter had already been written and tested
entirely against a stub. Every finding below contradicted an assumption.

The captured stream is kept at
`packages/core/src/adapters/__fixtures__/codex-real-stream.jsonl` and is
replayed by `codex-real-stream.test.ts`.

## 1. The event schema was entirely wrong

The adapter expected `session_configured`, `agent_message`, `task_complete`,
`usage_limit_reached`. None exist. The real envelope is:

```json
{"type":"thread.started","thread_id":"01a096ac-..."}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"..."}}
{"type":"turn.started"}
{"type":"error","message":"..."}
{"type":"turn.failed","error":{"message":"..."}}
```

Events are flat top-level objects, not wrapped in an app-server `{id, msg}`
envelope.

The symptom would not have been a missing feature. `thread.started` is what
makes a session ready, so without mapping it, `start()` never resolves and a
run never begins. The adapter was 100% test-covered and 0% functional.

## 2. `codex exec` refuses to run outside a git repository

> Not inside a trusted directory and --skip-git-repo-check was not specified.

CAPO always runs a session in a task's git worktree, so this does not bite in
practice. It would bite anyone testing the adapter in a scratch directory.

## 3. Warnings arrive as error-typed items

A real run emits error items before the turn even starts: a clamped plugin hook
timeout, a model metadata cache miss. These are warnings. Treating an error
item as fatal would make CAPO unusable on any machine with plugins installed.
They are mapped to retryable errors.

## 4. Model names in the docs were wrong

Both documented Codex models were rejected:

- `gpt-5-codex` — "not supported when using Codex with a ChatGPT account".
- `gpt-6-astra` (the account's configured default) — "requires a newer version
  of Codex. Please upgrade."

So the example config would have failed on a user's first run. Model names are
now placeholders with a note to check them against your own account using
`codex exec -m <model> "hi"`.

## Still unverified

A successful Codex turn has never been captured, because the account's model
needs a newer CLI than 0.147.0. So:

- `turn.completed` is inferred, not observed.
- The `item.type` for assistant prose is inferred. The mapper matches
  permissively (`/message|agent|assistant|text/`) rather than pinning a name.
- The usage-limit shape is still unknown. Detection is message-pattern based
  (`/usage limit|rate limit|quota exceeded|too many requests/`), which will
  catch a limit reported as text but would miss a dedicated event type.

Limit detection remains the single highest-risk unverified thing in CAPO, and
it is the feature the whole product exists for.

## The lesson

The Claude Code adapter is in the same position: written against a stub, never
run against the real CLI. Its schema was at least taken from documented
`stream-json` output rather than invented, but it has not been proven either.
A live run is worth more than any amount of stub testing.
