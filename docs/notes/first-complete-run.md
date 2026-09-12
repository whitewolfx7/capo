# The first run that finished

Recorded 2026-09-13. A real end-to-end run on live Codex, from `capo run` to
a merged, checked, self-terminating `done`. Until this run, no CAPO run had
ever completed: the integration engine was built and tested but nothing
called it, and the CLI had no exit path.

## Setup

`examples/two-coordinators`, copied to a throwaway git repo. Two independent
bugs, one per task, with non-overlapping write scopes:

- `component-a`: `add(a, b)` returned `a - b`
- `component-b`: `multiply(a, b)` returned `a + b`

One platform (`codex`), model `gpt-5.6-sol`, three sessions: `root`,
`team-a`, `team-b`. `check_command: ["node", "--test", "src/component-a/add.test.mjs", "src/component-b/multiply.test.mjs"]`.

## What happened

Both coordinators worked in their own worktrees on their own branches, fixed
their own bug, committed, and sent an unprompted result block. CAPO accepted
both, merged them one at a time into an integration worktree, ran the check
command over the combined tree, marked both tasks `done`, set the run `done`,
closed every session, and exited 0 — with nobody pressing Ctrl-C.

```
$ git -C .capo/runs/2026-09-12-001/integration log --oneline -6
c3e6f49 Merge commit '587f678...' into capo/integration/2026-09-12-001
6c2463c Merge commit '279ad7c...' into capo/integration/2026-09-12-001
279ad7c Fix component-a addition
587f678 Fix component-b multiplication helper
b07f4ee use gpt-5.6-sol
c1c5d1b e2e config

$ node --test src/component-a/add.test.mjs src/component-b/multiply.test.mjs
# pass 2, fail 0
```

`team-b`'s result block, verbatim from its transcript — written on its own
initiative, with no request from CAPO, in the shape `RESULT_PROTOCOL`
describes:

```markdown
# Result: component-b
task: component-b
commit: 587f6786d6023e33467fbcf7f5c9dc37cbecdb4a

## Evidence
Changed `multiply(a, b)` to return `a * b`. `node --test src/component-b/multiply.test.mjs`
passes 1/1. The combined suite passes component-b; its sole remaining failure
is the independently owned component-a test.
```

`team-a` delegated to a real worker through Codex's own subagent mechanism,
then checked the worker's commit itself before reporting — the worker
delegation path, which CAPO can only reach by briefing the coordinator, works
against a live agent.

## What this run found

**The root did the work itself.** While its coordinators were working, the
root session fixed both bugs by hand and committed them directly to `main`:

```
$ git log --oneline -3 main
813ba86 Fix multiply arithmetic operation
6c8f6cc Fix component A addition
b07f4ee use gpt-5.6-sol
```

Harmless here — both tasks still integrated correctly from their own
worktrees — but wrong in every way that matters. The root runs in the shared
workspace, not a task worktree, so its writes land outside every declared
write scope and inside the tree CAPO integrates into. Nothing checked them.

The cause was the role instructions, not the code: `roles/root.md` told the
root to "integrate its result — merge the committed diff, confirm it stayed
inside its declared write scope, and run the check command." That was written
when integration had no other owner. CAPO now does all of it mechanically, so
the instruction was asking the root to redo work the orchestrator had already
taken over. Both root role files now say plainly that the root neither writes
code nor integrates, and why.

**An unsupported model hangs the run.** Two earlier attempts failed because
`gpt-5.6` and `gpt-5-codex-mini` are both rejected on a ChatGPT account:

```
The 'gpt-5-codex-mini' model is not supported when using Codex with a ChatGPT account.
```

Every session failed within seconds. The orchestrator then sat at `running`
indefinitely — nothing watched for the case where no session is left alive to
finish the work. Fixed: the last live session ending with the run unfinished
now ends the run as `failed` and exits non-zero.

## Still unproven

- A run that spans a platform switch mid-task, end to end.
- A real usage limit firing. Every limit path is still exercised only against
  captured fixtures.
- A merge conflict between two tasks. Config loading rejects overlapping
  write scopes, so the normal path cannot produce one; the conflict branch is
  covered only by `integrate/merge.test.ts` directly.
