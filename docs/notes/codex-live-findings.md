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

## 5. The system prompt was never sent

`codex exec` has no `--append-system-prompt`. Its PROMPT argument is documented
as "initial instructions for the agent" and is the only input channel. The
adapter passed only `opts.prompt` and dropped `opts.systemPrompt` entirely.

A live session replied:

> No concrete objective appears in the visible request.

The system prompt carries the objective, role instructions, write scope and the
checkpoint protocol. Without it no Codex session could ever have survived a
platform switch. The system prompt is now prepended to the first turn. The same
agent then said it would "minimally fix only `src/a/`".

## 6. Task branches collided between runs

Branches were named `capo/<task-id>` and outlive `.capo/`. A second run, or a
retry after a failure, died on `fatal: a branch named 'capo/task-a' already
exists` before launching anything. They are now `capo/<run-id>/<task-id>`.

## 7. A real agent's checkpoint had no metadata

This is the big one, and it only appeared because a real switch was forced
against a real agent mid-task.

The agent produced a well-formed, parseable checkpoint. Every narrative section
was sensible. Every header field was blank:

```
# Checkpoint: team-a
run:
role:
platform:
written:
base_commit:
```

It parsed cleanly and was written to disk carrying no identity, which would
have made a resume attribute the work to nothing.

The agent was not misbehaving. A session has no reliable way to know its run id
or the base commit. Asking it to restate them invites a confident wrong answer.
CAPO now stamps all metadata itself and discards whatever the session claimed:
the session supplies the narrative, CAPO supplies the facts.

## 8. Agents stall on approval, and nothing notices

A real coordinator correctly diagnosed its bug, then ended its turn with:

> This is bounded: change `add` from subtraction to addition, then verify with
> Node; approve?

It then sat idle. CAPO has no approval channel. `docs/architecture.md` claims
"Approvals and questions from any session are surfaced in the CAPO terminal";
that is not implemented. Today a real Codex agent stalls on the first action
needing permission and the run quietly stops making progress.

This is the largest known gap. Options are to run Codex with approvals
bypassed, which has obvious risk, or to surface approval requests and let a
person answer them.

## What a live run confirmed works

- Sessions start and become ready from the real `thread.started` event.
- Assistant text and tool calls stream into transcripts in real time.
- Plugin warnings arriving as error items are correctly non-fatal.
- **A real Codex agent, given the protocol, produces a checkpoint that
  `parseCheckpoint` reads.** This was the single biggest unverified assumption
  in the project.
- A forced switch checkpointed all three live sessions, wrote set `001`, and
  moved the team.

## Still unverified

A successful Codex turn has never been captured, because the account's model
needs a newer CLI than 0.147.0. So:

- ~~`turn.completed` is inferred~~ Observed. It carries a `usage` object with
  input, cached input, output and reasoning token counts.
- ~~The `item.type` for assistant prose is inferred~~ Observed: `agent_message`
  with the prose in `text`. The permissive matcher handled it correctly.
- The usage-limit shape is still unknown. Detection is message-pattern based
  (`/usage limit|rate limit|quota exceeded|too many requests/`), which will
  catch a limit reported as text but would miss a dedicated event type. Hitting
  a real limit is the only way to settle it.

Limit detection remains the single highest-risk unverified thing in CAPO, and
it is the feature the whole product exists for.

## Model names

`gpt-5.6` is not a model. The real ones are listed in
`~/.codex/models_cache.json`. On this account: `gpt-6-astra` (needs a newer CLI
than 0.147.0), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`,
`gpt-5.3-codex-spark`. `gpt-5.6-sol` works. `gpt-5-codex` does not exist for a
ChatGPT account.

## The lesson

Eight defects, all found by one live run, in code that had 220 passing tests.
Six of them were invisible to any amount of stub testing, because the stub
encoded the same wrong assumptions as the adapter.

The Claude Code adapter is still in that position: written against a stub,
never run against the real CLI. Its schema at least came from documented
`stream-json` output rather than invention, but on this evidence that is not
much reassurance.
