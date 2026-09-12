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

Status: v0.1, working, not yet verified against a real usage limit. See
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

Every task gets its own git worktree and a declared write scope. Before the
root integrates a result, CAPO independently checks the diff against that
scope, including files moved out of it by a rename. Accepted results merge one
at a time into an integration worktree, and the combined checks run there.

A coordinator saying it finished does not make a run successful. Only the
integrated, tested result does.

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

v0.1 deliberately stops well short of the full design in
[docs/roadmap.md](docs/roadmap.md). Not included:

- Moving a single task between platforms while the rest of the team keeps
  running. v0.1 moves the whole team at once.
- Running on both subscriptions concurrently. One active platform at a time.
- A long-running service, leases, fencing tokens, or an event journal.
- An adapter SDK or third-party platforms such as Gemini.
- Usage-aware routing ahead of limits, and automatic switch-back.

**Not yet verified:** every test runs against fake platform adapters, so limit
detection has never met a real usage limit. Codex's exact wire shape for a rate
limit in particular is an educated guess. Until a live run confirms both, treat
limit detection as unproven.

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
[docs/notes/codex-live-findings.md](docs/notes/codex-live-findings.md) explains
why in detail.

Security issues go through
[private vulnerability reporting](https://github.com/whitewolfx7/capo/security/advisories/new),
not public issues. See [SECURITY.md](SECURITY.md).

By participating you agree to the [code of conduct](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE).
