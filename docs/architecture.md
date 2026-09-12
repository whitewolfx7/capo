# CAPO — Concurrent Agent Platform Orchestrator

Status: v0.1 design for review; no runtime implemented or published.
Date: 2026-09-12.

## Why

Pro subscriptions on Claude Code and Codex run out of usage daily. CAPO runs one
agent team across both platforms: when the active platform hits its usage limit,
the whole team checkpoints and continues on the other one. Two subscriptions,
one continuous session of work.

CAPO is a fun open-source side project. The v0.1 rule is: keep it simple. The
full design, with leases, journals, a long-running service, and an adapter SDK,
lives in [roadmap.md](roadmap.md) and is not part of v0.1.

CAPO is installed as a plugin in Claude Code and in Codex. Either host
conversation can start, watch, switch, and resume a run. Both plugins drive the
same CLI and the same `.capo/` directory on disk.

## The rule

1. A run has one **active platform** at a time. All sessions run there.
2. Each role has a **model per platform** in the config. Launching on a platform
   uses that platform's column.
3. When the active platform reports a **usage limit**, CAPO pauses every
   session, has each write a checkpoint, and relaunches the whole team on the
   other platform from those checkpoints. The root moves too.
4. When **both** platforms are capped, CAPO records the earliest known reset
   time and waits for it. Nothing is lost; resume is the same as a switch.
5. Switching back is allowed once the original platform resets, but v0.1 never
   switches on its own except on a limit.

## Roles

- **Root**: owns the objective, breaks it into tasks, assigns them to
  coordinators, integrates results. One root per run.
- **Coordinators**: one platform session each. Subdivide their tasks and spawn
  native subagents for the pieces. Report results and blockers to the root.
- **Workers**: the platform's native subagents (Claude Code Agent tool, Codex
  subagents). They are not tracked as separate sessions by CAPO; their output
  comes back through their coordinator.

Roles are independent of platform. A root that starts on Codex can finish on
Claude Code.

## Configuration

```yaml
version: 1
workspace: .
objective: ./context/GOAL.md

platforms:
  claude:
    driver: claude-code
  codex:
    driver: codex-app-server

start_on: claude

models:            # role -> platform -> model (names illustrative; use each CLI's real IDs)
  root:
    claude: opus
    codex: gpt-5-codex
  coordinator:
    claude: sonnet
    codex: gpt-5-codex-mini
  worker:
    claude: haiku
    codex: gpt-5-codex-mini

roles:
  root: ./roles/root.md
  coordinator: ./roles/coordinator.md
  worker: ./roles/worker.md

context:
  - ./context/PROJECT.md
  - ./context/CONTRACTS.md

coordinators:
  - id: team-a
  - id: team-b

tasks:             # optional; root decomposes the objective if empty
  - id: component-a
    coordinator: team-a
    brief: ./tasks/component-a.md
    write_scope: [src/component-a/]
  - id: component-b
    coordinator: team-b
    brief: ./tasks/component-b.md
    write_scope: [src/component-b/]

limits:
  max_workers_per_coordinator: 2
```

Validation before launch: known platform drivers, every role has a model for
every configured platform, unique IDs, briefs and role files exist, write scopes
inside the workspace and non-overlapping. Relative paths resolve against the
config file. Credentials come from each platform CLI's normal login; CAPO never
stores them.

## Checkpoints

The checkpoint is the core of CAPO. Since the whole team moves at once, nobody
on the new platform has any memory. Whatever each agent writes before it pauses
is everything the new side gets. It is plain Markdown so a person can read it,
edit it, or paste it into a session by hand.

One file per session at `.capo/runs/<run-id>/checkpoints/<n>/<session-id>.md`, where `<n>` is the pause number:

```markdown
# Checkpoint: team-a
run: 2026-09-12-001
role: coordinator
platform: claude
written: 2026-09-12T14:20:05Z
base_commit: 3f2a9c1

## Objective
(what this session was responsible for, in its own words)

## Decisions made
- ...

## Done
- files changed, commits, tests that pass

## In progress
- what was mid-flight when paused, and its exact state

## Remaining
- ordered next steps

## Blockers and open questions
- ...
```

The root's checkpoint also carries the task table: each task, its coordinator,
state, and write scope. A `CHECKPOINT.md` index at the run level lists every
session file and the reason for the pause (limit, user, both-capped).

Rules:

- Sessions write checkpoints on request from CAPO, not on their own schedule.
- Work is committed to the task's worktree before the checkpoint is written, so
  the checkpoint references commits, not dirty files.
- A relaunched session receives its role instructions, the shared context, and
  its own checkpoint. It does not receive the previous platform's transcript.
- Checkpoints are never overwritten. Each pause writes a new set under a
  numbered directory; the latest is what resume uses.

## Runtime

A small TypeScript CLI. No database and no long-running service in v0.1. The
plugins call this CLI; they do not contain a second implementation.

```text
capo run --config ./orchestration.yaml     # start a run
capo resume <run-id>                       # continue from latest checkpoint
capo switch <run-id> [--to claude|codex]   # force a checkpoint and switch
capo status <run-id>                       # which platform, which sessions, task table
```

State on disk, gitignored:

```text
.capo/
  runs/<run-id>/
    config.resolved.json     # frozen effective config
    state.json               # active platform, session ids, task table, reset times
    checkpoints/<n>/         # one directory per pause
    STATUS.md                # generated readable view
```

`state.json` is rewritten atomically after each change (write temp, rename).
That is the whole persistence story for v0.1.

`capo run` starts the orchestrator as a detached background process and
returns. It must outlive the host conversation that launched it, because that
conversation is on the platform most likely to get capped. `status`, `switch`,
and `resume` work by reading and updating `state.json` and signalling the
running process, so they behave the same from the terminal or from either
plugin.

Each task gets a git worktree from the run's base commit. Write scopes are
declared, and CAPO checks a submitted diff stays inside its scope before the
root integrates it. There are no leases or fencing tokens; one active platform
at a time means there is no second writer to fence.

## Platform adapters

Two adapters, both in-process, both driven through their vendor's documented
programmatic surface:

- **Claude Code**: headless JSON event mode with session IDs and explicit
  resume. Native subagents via the Agent tool.
- **Codex**: App Server over stdio for session start, streaming events,
  interrupt, and approvals. Native subagents via Codex's subagent support.

Each adapter must do four things: start a session with a role, model, and
initial prompt; send a message; stream events; and report a **usage limit** as
a structured event with a reset time when the platform provides one. Limit
detection is the one adapter feature v0.1 cannot ship without, and it needs a
live test on each platform, not only a fixture.

Approvals and questions from any session are surfaced in the CAPO terminal.

## Plugins

Two host-specific bundles with the same CAPO identity:

```text
plugins/
  claude/capo/
    .claude-plugin/plugin.json
    .mcp.json                # points at the bundled CAPO MCP server
    skills/                  # /capo run, status, switch, resume
    dist/                    # self-contained CLI + MCP server build
  codex/capo/
    .codex-plugin/plugin.json
    .mcp.json
    skills/
    dist/
```

Each plugin is a thin control surface:

- **Skills** explain to the host conversation how to start a run from a config
  file, read status, force a switch, and resume.
- **MCP server** exposes `capo_run`, `capo_status`, `capo_switch`, and
  `capo_resume`. Each tool shells out to the bundled CLI and returns its output.
  The server holds no state of its own.
- **Role instructions** for root, coordinator, and worker ship inside the
  plugin so an auto-launched session on either platform gets the same roles
  regardless of the user's global settings.

Rules:

- The plugin resolves its CLI relative to its own installed root. Installation
  must not depend on a development checkout or a global npm install.
- Both plugins read the same project `.capo/` directory. Starting a run from
  Claude Code and checking on it from Codex is the normal flow, not a special
  case, because after a switch the Claude Code host may itself be capped.
- Node is a documented prerequisite. `capo doctor` (also exposed through the
  plugin) checks Node, both platform CLIs, and their login state.
- Uninstalling a plugin never touches `.capo/` or a running orchestrator.
- The host conversation that launches a run is a control panel, not the root.
  The root is a separate session started by the CLI with the configured model.
  Letting the host conversation act as root is a roadmap item.

Release requires a clean install of each plugin from its built bundle on a
fresh machine, discovery of the CAPO skills and MCP tools in both hosts, and a
run started from one host and switched from the other.

## Integration

Coordinators report a task done with its worktree commit and test evidence. The
root merges accepted tasks one at a time into an integration worktree, runs the
combined checks, and marks the run complete. A coordinator's own report never
marks the run done.

## Acceptance demo

1. Start a run on Claude with two coordinators and a synthetic repo. Each
   coordinator spawns at least one native worker.
2. Inject a usage-limit event (fixture) while work is in flight.
3. Every session checkpoints. The whole team, root included, relaunches on
   Codex using the Codex model column.
4. Work finishes on Codex. The root integrates and tests the combined result.
5. Run the same demo started from the Claude Code plugin and switched by hand
   from the Codex plugin.
6. Repeat with a real limit on at least one platform before calling v0.1 done.

Also verify: both-capped waits and resumes at reset; `capo switch` by hand;
resume after killing the CLI mid-run; out-of-scope diff rejected; invalid
config rejected before any model call.

## Later

Everything below is deliberately out of v0.1. The detailed design for each is
in [roadmap.md](roadmap.md).

- Moving a single task between platforms while the rest of the team keeps
  running (per-task handoffs, hints, fencing tokens, leases).
- Mixed-platform teams running concurrently on both subscriptions at once.
- Append-only journal with crash-durability testing and snapshot recovery.
- A long-running local service with authenticated IPC, so a host conversation
  can attach as the root instead of starting a separate root session.
- Marketplace listing and auto-update for the plugin bundles.
- Adapter SDK, stdio adapter protocol, conformance suite, third-party
  platforms such as Gemini.
- Usage-aware routing ahead of limits, and automatic switch-back.

## References

Installed CLI versions observed: Codex 0.147.0; Claude Code 2.1.236. Presence
and help output were checked; authenticated agent runs have not been tested.

- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex subagents: https://learn.chatgpt.com/docs/agent-configuration/subagents
- Claude programmatic sessions: https://code.claude.com/docs/en/headless
- Claude native subagents: https://code.claude.com/docs/en/sub-agents
- Claude plugin packaging: https://code.claude.com/docs/en/plugins-reference
- Codex plugin authoring: https://learn.chatgpt.com/docs/build-plugins
