# Claude Code: what live runs actually showed

Recorded 2026-09-12 against a real, logged-in `claude` 2.1.236, after the
adapter had been written and tested entirely against a stub. Companion to
[codex-live-findings.md](codex-live-findings.md), which records the same
exercise for Codex.

Two rounds. The first drove the adapter directly. The second ran a full CAPO
orchestration, which found things a single session never could.

## Round 1: driving the adapter

Captured streams live at
`packages/core/src/adapters/__fixtures__/claude-real-stream.jsonl` and
`claude-real-toolcall.jsonl`, replayed by `claude-real-stream.test.ts`.

### 1. Usage limits were being read from the wrong channel

The adapter matched assistant prose for `usage limit reached`. A live run never
produced that phrase anywhere in `stream-json` output.

What exists instead is a structured top-level event:

```json
{"type":"rate_limit_event",
 "rate_limit_info":{"status":"allowed|allowed_warning|rejected",
                    "resetsAt":<unix seconds>,
                    "rateLimitType":"..."}}
```

Confirmed independently: the installed binary contains `rate_limit_event`,
`rate_limit_info`, `rateLimitType`, `allowed_warning` and `resetsAt` in its own
embedded schema. So the single feature CAPO exists for was watching a channel
that never carries the signal.

`status: "rejected"` is now the primary source. `allowed_warning` is a bonus the
old design could not have used at all: it means a limit is approaching rather
than already hit.

**Still unverified:** `rejected` has never fired. Neither account hit a limit.
The mapping is schema-derived, which is far better than the previous guesswork,
but it is not end-to-end proof.

### 2. `system`/`init` repeats before every turn

Not just at startup. The adapter re-queued a `ready` event on every turn after
the first. No test caught it because no test ran two turns and inspected the
whole event list.

### 3. A failed turn was silently swallowed

A `result` line can carry `is_error: true` with no assistant text explaining
why. Every `result` was mapped to a plain `turn-end`, so failures vanished.

### 4. Approvals do not stall, unlike Codex

`--permission-mode acceptEdits` in `-p` mode auto-approved both a `Write` and a
`Bash` tool call with no hang and no approval channel needed. The stall problem
is Codex-specific.

## Round 2: a full orchestration run

Config: two coordinators, one task each, two genuine one-line bugs, real
`claude` with `haiku`, `autonomy: autonomous`.

### 5. A deadlock that made every real run impossible

The first attempt hung with zero sessions ready. The cause:

- `start()` awaited a `ready` event derived from `system`/`init`, and only then
  wrote the first prompt to stdin.
- Claude Code does not emit `init` until it has received a first user message.
  With stdin open and nothing sent, it emits only SessionStart hook events and
  waits.

Probed directly. With stdin held open and empty for 12 seconds, six lines
arrived, all `system`/`hook_started` and `system`/`hook_response`, no `init`.
Send one user message and `init` appears immediately after the hook events.

So both sides waited forever. **No stub could catch this**, because a stub emits
`init` whether or not anyone speaks first. The stub now mirrors the real
ordering, the prompt is written before awaiting ready, and the wait is bounded
so a future mismatch is an error rather than a silent hang.

### 6. Worktree isolation was fiction

CAPO creates a git worktree per task and records it in state. Every session was
then launched with `cwd` set to the shared workspace, so the worktrees were
never used.

The run made it concrete. Both coordinators edited
`<workspace>/src/...` directly, while `.capo/runs/<id>/worktrees/calc/` and
`worktrees/fmt/` still held the original buggy code.

Consequences, all of them silent: no isolation between coordinators, write
scopes reduced to advisory text in a prompt, and integration with nothing to
merge. It also invalidated part of the written justification for defaulting to
`autonomy: autonomous`, which cited worktree isolation as a reason more
autonomy was safe. Both the code and that comment were corrected.

### 7. The agents did the work

Worth recording, because it is the first time real agents completed real work
under CAPO. Both coordinators read their brief, diagnosed a one-line bug,
edited the file, ran the test, and committed. Both tests passed afterwards.

From `team-calc`'s transcript:

> **Phase 2 & 3 - Pattern Analysis & Hypothesis:** The fix is straightforward:
> change `-` to `+` on line 1 of sum.mjs.

### 8. And CAPO orchestrated none of the last mile

Both tasks still read `state=ready` and the run still read `running` after the
work was finished and correct. Nothing signals completion, nothing advances
task state, and `integrate()` is never called by a run. CAPO launched a team
that happened to do the right thing; it did not run a project to completion.

## The lesson, again

Round 1 fixed three bugs a stub could never have found. Round 2 then found two
more that even a live single-session test could not, because they only appear
when the whole orchestration runs. Each layer of realism found defects the
layer below was structurally blind to.
