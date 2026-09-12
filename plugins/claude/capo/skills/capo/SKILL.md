---
name: capo
description: Drive the CAPO CLI to run one AI agent team across Claude Code and Codex. Use when the user wants to start, check, switch, or resume a CAPO run, or when the user says they are close to a Claude Code usage limit and wants to keep the run going on Codex. Also use for "capo run", "capo status", "capo switch", "capo resume", "capo doctor", or any request to move an agent team to the other platform before it hits a limit.
version: 0.1.0
---

# Skill: capo

CAPO runs one AI agent team across Claude Code and Codex. When the platform a
run is currently on hits its usage limit, CAPO checkpoints every live session
to Markdown and relaunches the same roles on the other platform from those
checkpoints. This skill is a thin control surface over the `capo` CLI — it
does not reimplement anything the CLI does.

**This conversation is a control panel, not the root session.** Running
`capo run` starts a detached background process that launches its own root
and coordinator sessions on the configured platform; it must outlive this
conversation, because this conversation is on the platform most likely to get
capped next. Never treat this conversation, or any reply you write in it, as
the root of the run — you are here to start it, watch it, and nudge it, not
to do the run's work yourself.

## Resolving the CLI

The bundled CLI lives at `dist/capo.mjs` inside this plugin's own installed
directory. Resolve it with Claude Code's plugin-root variable so it never
depends on a development checkout or a global npm install:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" <command> [flags]
```

Every example below uses that exact form. Run `capo doctor` first if you are
unsure whether this machine is set up correctly.

## Commands

### `run` — start a run from a config file

```
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" run --config <path> [--foreground] [--start-on <platform>]
```

Starts the orchestrator as a detached background process and returns
immediately. `--config` is required and points at the run's `orchestration.yaml`.

Worked example:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" run --config ./orchestration.yaml
```

### `status` — which platform, which sessions, task table

```
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" status [<run-id>] [--json] [--workspace <dir>]
```

With no `<run-id>`, shows the most recent run found under `.capo/`. Use
`--json` when you need to parse the output instead of reading it.

Worked example:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" status 2026-09-12-001 --json
```

### `switch` — force a checkpoint and move a live run to another platform

```
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" switch <run-id> [--to <platform>]
```

Requires a `<run-id>`. Omit `--to` to let CAPO pick the platform that is not
currently active.

**When the user says they are close to a usage limit, run `capo switch`
proactively — do not wait for the platform to error.** A voluntary switch
checkpoints cleanly while every session is still responsive; an error mid-turn
does not give a session the chance to write down what it was doing. If the
user mentions being near a limit, near a cap, running low on usage, or asks
"should I switch now", treat that as a cue to run this command, after
confirming with the user which run they mean if more than one is active.

Worked example:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" switch 2026-09-12-001 --to codex
```

### `resume` — continue a run from its latest checkpoint

```
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" resume <run-id>
```

Requires a `<run-id>`. Use this after a run stopped (for example both
platforms were capped and it went to `waiting`) to relaunch its sessions from
the latest checkpoint set on disk.

Worked example:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" resume 2026-09-12-001
```

### `doctor` — check that this machine can run capo

```
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" doctor [--json]
```

Checks Node, both platform CLIs, and their login state. Run this first when
setting CAPO up, or whenever a run fails to start for an unclear reason.

Worked example:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/capo.mjs" doctor
```

## How to use this skill in conversation

- Starting a run: confirm the config path with the user, then run `capo run`.
  Report back the run id it prints so the user can refer to it later.
- Checking in: run `capo status <run-id>` and summarize the platform, the
  sessions, and the task table in plain language rather than dumping raw
  output.
- Near a limit: run `capo switch <run-id>` and tell the user which platform
  the run is moving to.
- Picking a stopped run back up: run `capo resume <run-id>`.
- Anything failing unexpectedly: run `capo doctor` before guessing further.

Both plugins — this one and the Codex one — read and write the same `.capo/`
directory in the project. Starting a run from Claude Code and checking on it
from Codex, or the reverse, is the normal flow: after a switch, this very
conversation may itself be on the platform that is now capped.
