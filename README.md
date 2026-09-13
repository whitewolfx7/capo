# CAPO

[![CI](https://github.com/whitewolfx7/capo/actions/workflows/ci.yml/badge.svg)](https://github.com/whitewolfx7/capo/actions/workflows/ci.yml)
[![CodeQL](https://github.com/whitewolfx7/capo/actions/workflows/codeql.yml/badge.svg)](https://github.com/whitewolfx7/capo/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**You run out of Claude Pro usage at 2pm. Your Codex quota is untouched. CAPO
moves the whole agent team over and keeps going.**

CAPO runs one agent team across Claude Code and Codex. When the platform you
are on reports a usage limit, every session writes a Markdown checkpoint, and
the entire team, root included, relaunches on the other platform from those
checkpoints. Two subscriptions you already pay for, one continuous session of
work.

Status: v0.1. Both platform adapters have run against their real CLIs, not
just a stub, and a full run has finished end to end on live Codex: two
coordinators fixed their own bug in their own worktree, reported results,
and CAPO merged both, ran the combined check, and exited on its own — see
[docs/notes/first-complete-run.md](docs/notes/first-complete-run.md). One
thing that would make this a finished product is still unproven: **no real
usage limit has ever fired**, which is the whole reason CAPO exists. Every
limit path is exercised against captured fixtures, not a live cap. See
[What is not done](#what-is-not-done).

## How it works

1. A run has one **active platform** at a time. Every session runs there.
2. Each role has a **model per platform**. Launching on a platform uses that
   platform's column.
3. On a **usage limit**, every session checkpoints, all of them close, and the
   team relaunches on the other platform. The root moves too.
4. When **both** platforms are capped, the run waits for the earliest known
   reset rather than flapping between them.
5. `capo resume` continues from the latest checkpoint set on disk, so a crash
   or a closed laptop costs you nothing.

The checkpoint is the whole trick. Because the team moves all at once, nobody
on the new platform has any memory. Whatever each agent writes before it pauses
is everything the other side gets. So checkpoints are plain Markdown you can
read, edit, and paste into a chat window by hand.

## Quickstart

```bash
git clone https://github.com/whitewolfx7/capo.git && cd capo
npm install && npm run build
node packages/cli/dist/main.js doctor
```

`doctor` checks Node, git, and both platform CLIs, and tells you what is
missing before a run starts rather than after it fails.

To get a `capo` command on your PATH, run `npm link -w packages/cli`, or
install the plugin into either host and let its skill call the bundled binary.
Everything below also works as `node <repo>/packages/cli/dist/main.js ...`.

Then, in a project you want worked on:

```bash
capo run --config ./orchestration.yaml
```

That prints a run id and detaches. The orchestrator keeps running after you
close the shell, which matters because the shell is often on the platform that
is about to get capped.

```bash
capo status                 # which platform, which sessions, which tasks
capo switch <run-id>        # checkpoint and move now, before hitting a limit
capo resume <run-id>        # continue from the latest checkpoint
```

## Configuration

```yaml
version: 1
workspace: .
objective: ./context/GOAL.md

platforms:
  claude: { driver: claude-code }
  codex:  { driver: codex }

start_on: claude

models:            # role -> platform -> model, using each CLI's own model names
                   # Codex model names are account- and CLI-version specific.
                   # The real list for your account is in
                   # ~/.codex/models_cache.json. Verified working on
                   # codex-cli 0.154.0: gpt-6-astra, gpt-5.6-sol.
                   # `codex exec -m <model> "hi"` settles any doubt.
  root:        { claude: opus,   codex: <your codex model> }
  coordinator: { claude: sonnet, codex: <your codex model> }
  worker:      { claude: haiku,  codex: <your codex model> }

roles:
  root: ./roles/root.md
  coordinator: ./roles/coordinator.md
  worker: ./roles/worker.md

context:
  - ./context/PROJECT.md

coordinators:
  - id: team-a
  - id: team-b

tasks:             # optional: leave empty and the root decomposes the objective
  - id: component-a
    coordinator: team-a
    brief: ./tasks/component-a.md
    write_scope: [src/component-a/]
  - id: component-b
    coordinator: team-b
    brief: ./tasks/component-b.md
    write_scope: [src/component-b/]

transcripts: true  # default; writes a live log per session you can tail -f

limits:
  max_workers_per_coordinator: 2
```

The model map is the point of the file. Put the expensive model on the root and
cheaper ones on coordinators and workers, per platform, and CAPO uses the right
column whichever platform it is on.

A bad config is rejected before any model call: an unknown platform in
`start_on`, a role missing a model for a declared platform, duplicate ids, an
unknown coordinator reference, write scopes that overlap or escape the
workspace, and missing files.

A runnable example lives in [`examples/two-coordinators/`](examples/two-coordinators).

## What a checkpoint looks like

This is a real one, and it is the only thing that crosses between platforms.

```markdown
# Checkpoint: team-a
run: 2026-09-12-001
role: coordinator
platform: claude
written: 2026-09-12T14:20:05.000Z
base_commit: 3f2a9c1

## Objective
Build the HTTP client with retries.

## Decisions made
- Reused the existing fetch wrapper rather than adding a dependency

## Done
- src/a/client.ts written; 4 tests pass at commit 9ab1c02

## In progress
- Exponential backoff: implemented, but the jitter test fails intermittently

## Remaining
- Fix the jitter test
- Document the retry policy in the README

## Blockers and open questions
- Need the root to decide whether retries are capped at 3 or 5
```

Checkpoints are never overwritten. Each pause writes a new numbered set under
`.capo/runs/<run-id>/checkpoints/`, alongside an index naming the reason for
the pause.

## Watching a run

CAPO's sessions are headless, so they never show up in Claude Code's or Codex's
session list and there is no window to open. Everything they do is mirrored to
disk instead.

```bash
tail -f .capo/runs/<run-id>/transcripts/*.md
```

That is the live view: what each session says, the tools it runs, and a loud
marker when a usage limit hits, followed by CAPO moving the team. Each launch
writes a header naming the platform and model, so a transcript that spans a
switch shows exactly where the session went.

`.capo/runs/<run-id>/STATUS.md` is rebuilt on every state change and holds the
same information `capo status` prints: sessions, tasks, limits seen, and
whether the run is parked waiting for a reset.

Transcripts are on by default. Set `transcripts: false` in the config to turn
them off.

`capo status` also prints each session's platform session id. For Claude Code
that is a real session id CAPO generated, so `claude --resume <id>` should
reopen that conversation.

## Ownership and integration

Every coordinator runs in its own git worktree, on its own branch, however
many tasks it owns — a coordinator is one session with one working directory,
so the session is the unit that can actually be isolated. Only the root runs
in your workspace, and only because it does no work there: it decomposes,
judges and reports.

Every task declares a write scope. A result is re-checked against it before
anything merges, renames included. Where a coordinator owns several tasks
they share its worktree, so that check is against the union of what that
coordinator owns; the boundary strictly enforced is the one between
coordinators, and nothing may write into another's scope.

A coordinator reports a finished task by sending a fenced `# Result:` block
naming its commit — unprompted, whenever the work is done. CAPO never asks
for one. A task moves `ready` -> `running` -> `review` -> `done`/`failed`,
and once every task has reported, the run integrates: each submitted commit
is re-checked against that task's declared write scope (including files moved
out of it by a rename), accepted results are merged one at a time into an
integration worktree, and `check_command` runs over the combined tree. A
rejected scope, a conflict, or a failing check fails that task and the run.

**A coordinator saying it finished does not make a task done.** Its report is
a claim; the scope check and the merge are what settle it. The root does not
perform integration either — CAPO does it mechanically, and the root's job is
judging whether the work meets the objective.

When integration finishes, the run ends and the process exits on its own.

CAPO commits with your own git identity and your own signing configuration. It
will tell you if git has no identity configured rather than inventing one.

## Installing as a plugin

See [docs/installation-claude.md](docs/installation-claude.md) and
[docs/installation-codex.md](docs/installation-codex.md).

Each plugin is a skill that teaches the host to drive the bundled CLI. There is
no MCP server, no background service, and no second implementation. Both hosts
read the same `.capo/` directory, so you can start a run from one and check on
it from the other. That is the normal flow, not an edge case: after a switch,
the host you started from may be the capped one.

The host conversation is a control panel. It is never the root session.

## What is not done

**No real usage limit has ever fired.** Limit detection, the checkpoint, the
switch and the relaunch are all exercised against captured fixtures and real
CLI output shapes, never against a live cap. This is the one remaining claim
in this README that has not been watched happen, and it is the reason CAPO
exists.

**A platform switch mid-task has not been run end to end.** A switch has been
driven by hand on a live run and the checkpoints round-tripped, but no run
has yet been switched mid-task and then carried through to a finished,
integrated result on the other platform.

Also not done:

- Moving a single task between platforms while the rest of the team keeps
  running. v0.1 moves the whole team at once.
- Running on both subscriptions concurrently. One active platform at a time.
- A long-running service, leases, fencing tokens, or an event journal.
- An adapter SDK or third-party platforms such as Gemini.
- Usage-aware routing ahead of limits, and automatic switch-back.
- Surfacing approvals or questions from a session anywhere. A session that
  stalls waiting for approval is only marked `stalled` (visible in `capo
  status`, `STATUS.md`, and its transcript); nothing lets a person answer it
  through CAPO. A live Codex coordinator hit exactly this and sat idle.

Found today, while running both adapters for real:

- CAPO never spawns a worker itself; coordinators do, using their host's
  native subagent mechanism. `roles/worker.md` and the worker model column in
  `models:` are handed to each coordinator to relay, which means the model
  choice is a request CAPO cannot enforce. A live Codex coordinator did
  delegate to a real worker and check its commit before reporting, so the
  path works — but nothing verifies which model the worker actually ran as.
- Installing straight from GitHub with no local clone should work now that
  the built plugin bundles are committed to the repository instead of
  gitignored, but nobody has run that path end to end yet.

**Not yet verified:** no real usage limit has fired on either platform.
Claude Code's detection was rewritten today to read the CLI's own structured
`rate_limit_event` (`rate_limit_info.status: allowed | allowed_warning |
rejected`), confirmed to exist in the installed CLI's schema — a real
improvement over pattern-matching assistant text — but the `rejected` status
itself has never been observed live. Codex's detection is still
pattern-matching text; its actual wire shape for a limit remains an educated
guess. Codex has also never run a full orchestration, only single turns and
one hand-forced switch. Until a live run confirms all of that, treat limit
detection as unproven.

## A note on terms of service

CAPO drives each vendor's own documented CLI, using your own separate
subscriptions, one at a time. It does nothing to circumvent, pool, or evade any
platform's usage limits. It reacts to a limit by moving to a different service
you also pay for, which is what you would do by hand.

## Development

```bash
npm test          # full suite
npm run typecheck # tsc --build
npm run build:plugins
```

Design is in [docs/architecture.md](docs/architecture.md), the full future
design in [docs/roadmap.md](docs/roadmap.md), and the build plan in
[docs/superpowers/plans/](docs/superpowers/plans).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The one rule worth reading before you
touch an adapter: a stub proves almost nothing here, and
[docs/notes/codex-live-findings.md](docs/notes/codex-live-findings.md) and
[docs/notes/claude-live-findings.md](docs/notes/claude-live-findings.md) explain
why in detail — a single live Codex run found eight real defects in code that
had 220 passing tests against the stub, and the first run that finished end to
end ([docs/notes/first-complete-run.md](docs/notes/first-complete-run.md))
found two more that every test in the suite was blind to. The Claude Code adapter has since had
its own live run too (see the header comment in
`packages/core/src/adapters/claude.ts`), which found and fixed three more:
a spuriously repeated `ready` event, a swallowed failed turn, and usage-limit
detection that was pattern-matching text no real run ever produces instead of
reading the CLI's actual structured event. Real coordinators running under
CAPO on Claude Code have since diagnosed and fixed real bugs against the
[`examples/two-coordinators`](examples/two-coordinators) project, with tests
passing on both sides — the closest thing to evidence yet that the design
works, short of surviving an actual usage limit.

Security issues go through
[private vulnerability reporting](https://github.com/whitewolfx7/capo/security/advisories/new),
not public issues. See [SECURITY.md](SECURITY.md).

By participating you agree to the [code of conduct](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE).
