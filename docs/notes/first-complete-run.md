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

## What CI then found

Pushing the above turned CI red on four integration tests that passed on
every developer machine. The cause was not the tests: a GitHub runner has no
git identity configured, and CAPO's integration merge deliberately passes no
identity of its own so that merge commits land as the user. So the merge
failed with "Committer identity unknown".

That alone would have been a legible failure. What made it a bug is what
happened next: `integrate()` treated *any* failed merge as a conflict, and a
merge that fails this way leaves no `MERGE_HEAD`, so the `git merge --abort`
that followed threw a second error out of the function. The caller saw only
that, and every task stayed at `review` with a failed run above it and no
reason recorded anywhere. All the model work was done and none of its
outcomes survived.

Three fixes:

- A merge that fails for a non-conflict reason is now re-thrown as itself
  rather than reported as a conflict with no files, and `merge --abort` only
  runs when a merge is actually in progress.
- When integration cannot run at all, every task still in `review` gets a
  note saying so, instead of a silent task table under a failed run.
- `Orchestrator.start()` and `capo doctor` now check for a git identity up
  front. It is not needed until integration, which is after every session has
  finished — so without a preflight the cheapest possible failure is
  discovered at the most expensive possible moment.

Reproduced locally with `user.useConfigOnly=true` and no global config, which
is what CI effectively is. The suite now passes under those conditions too.

## The same thing on Claude Code

Recorded 2026-09-13. The same fixture, `start_on: claude`, all three sessions
on Sonnet. It took two attempts.

The first attempt failed in a way no amount of stub testing would have
surfaced. Both coordinators wrote the correct fix, then discovered they could
not run anything. From `team-a`'s transcript, verbatim:

> every mutating/execution Bash command in my session (`node --test ...`,
> `node -e ...`, `git add`, `git commit`) is being auto-denied with "This
> command requires approval," while read-only commands (git status, git log,
> pwd, which, node --version) go through fine.

CAPO launched Claude sessions with `--permission-mode acceptEdits`, which
accepts file edits and denies mutating Bash. A coordinator that cannot run
`git commit` can never produce a result commit, so the result protocol is
unreachable and the run cannot end. Both coordinators independently
escalated it to the root rather than routing around the restriction, which is
the behaviour the role instructions ask for and a good sign on its own.

A comment in `adapters/claude.ts` claimed a live run had confirmed
`acceptEdits` auto-approves Bash. It had not: that probe ran a `Write` and
some read-only commands, and the conclusion was over-generalised. The comment
is corrected in place rather than quietly deleted.

`autonomy: autonomous` now maps to a full permission grant on Claude Code.
That is a real grant and the code says so plainly. What bounds it is that
every coordinator runs confined to its own git worktree, and `autonomous` is
the setting whose entire meaning is acting without asking. `supervised` is
unchanged.

The second attempt finished: both tasks fixed, merged, `node --test` passing
2/2 over the integrated tree, run `done`, process exited 0.

```
$ git -C .capo/runs/2026-09-13-001/integration log --oneline -4
92a6be8 Merge commit '734a006' into capo/integration/2026-09-13-001
0d67273 Merge commit 'a0e0cd23...' into capo/integration/2026-09-13-001
734a006 Fix multiply() to return a * b instead of a + b
a0e0cd2 Fix add() to sum instead of subtract
```

And the fix from the Codex run held: the root stayed out of the work. The
workspace's `main` carried no commits from it, where the first finished run
had two.

## A run carried across a platform switch

Recorded 2026-09-13. Started on Claude, switched to Codex once `team-a` had
real committed work in its worktree, and carried through to an integrated
result on the other platform.

The switch itself did what it claims: `pauses: 1`, checkpoint set `001`
written for all three sessions, every session relaunched on Codex, and both
coordinators' work survived. The integration worktree carries one commit from
each side of the switch:

```
ccfc40c Merge commit '9398727...' into capo/integration/2026-09-13-001
83483cd Merge commit 'd561c0b...' into capo/integration/2026-09-13-001
9398727 Fix component-b multiplication helper      <- written on Codex
d561c0b Fix add() to sum instead of subtract       <- written on Claude
2856210 fixture
```

Combined check 2/2, run `done`, exit 0. That is the whole premise working
once, by hand: the team moved platforms mid-task and finished on the other
side.

Two things this found:

**A checkpoint can silently under-report.** `team-a`'s checkpoint had
`## Done: _none_` while describing, under `## Decisions made`, the commit it
had already made. A session resuming on the other platform sees nothing but
the checkpoint, so "Done: none" invites it to redo committed work. The
checkpoint request now says explicitly that committed work belongs under
`## Done`, and why.

**The check-failure path ran live for the first time**, by accident: the
fixture's `check_command` used `node --test <directory>`, which fails on Node
23. CAPO handled it correctly — merged both results, ran the check, failed
both tasks with the note "merged, but the combined check command failed",
failed the run, and exited. The work itself was fine; the check command was
wrong. Worth recording because it is the first evidence that a failing
combined check is reported accurately rather than swallowed.

## Still unproven

- A real usage limit firing. Every limit path is still exercised only against
  captured fixtures, which is the one claim in the README nobody has watched
  come true.
- A merge conflict between two tasks. Config loading rejects overlapping
  write scopes, so the normal path cannot produce one; the conflict branch is
  covered only by `integrate/merge.test.ts` directly.
- Registering the plugin with a host from the GitHub marketplace entry. A
  fresh `git clone` of the repository does run the committed bundle
  standalone with no install step, and `capo doctor` passes from it.

## A switch under review, and what it changed

Recorded 2026-09-13. Two more live runs of the fixture on Haiku, the second
forced to Codex at 20 seconds. Both integrated 2/2. The second found: the
relaunched root spawned two Codex subagents that committed both fixes to
the workspace's `main`; one of three checkpoints was synthesized empty
because the request landed mid-turn and the model answered with its result
instead; the root loaded this machine's CAPO plugin skill and drove `capo
status` against its own run. The root is now launched read-only, Claude
sessions drop user-scope settings, checkpoints are re-asked once and
augmented from git, and a limit-triggered pause asks nobody.
