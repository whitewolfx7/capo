# CAPO — Concurrent Agent Platform Orchestrator

Status: v0.1 implemented, not published. Date: 2026-09-13.

## What exists today

Built and tested, and — for the platform adapters specifically — no longer
resting only on fake ones:

- Config loading and validation, rejecting a bad setup before any model call.
- The run directory, atomic state file, and the Markdown checkpoint format.
- Git worktrees per task and write-scope enforcement including renames. A
  coordinator that owns exactly one task runs inside that task's worktree.
- The result protocol and integration: a coordinator reports a finished task
  as a fenced `# Result:` block naming its commit, tasks move
  `ready` -> `running` -> `review` -> `done`/`failed`, and once every task has
  reported, accepted results are merged one at a time into an integration
  worktree and the configured `check_command` runs over the combined tree.
  When that finishes the run ends and the process exits on its own.
- The Claude Code and Codex adapters, both satisfying a shared conformance
  suite. Both have now been run against their real CLIs, not only the fake
  one. The Claude Code run found and fixed three real bugs: a repeated
  `system`/`init` line was spuriously re-queuing a `ready` event on every
  turn, a failed `result` line was being treated as a normal turn end instead
  of surfacing an error, and usage-limit detection was pattern-matching
  assistant prose for a phrase a real run never produces. It now reads the
  CLI's own structured `rate_limit_event` / `rate_limit_info` object instead
  (`status: allowed | allowed_warning | rejected`, plus `resetsAt` and
  `rateLimitType`) — see `packages/core/src/adapters/claude.ts` and
  `__fixtures__/README.md` for the captures this came from. The earlier
  Codex live run found and fixed eight further defects; see
  [notes/codex-live-findings.md](notes/codex-live-findings.md).
- The orchestrator: checkpoint, switch on a usage limit, wait when both
  platforms are capped, and resume from the latest checkpoint set on disk. A
  stall watchdog marks a session `stalled` — in state, `STATUS.md`, and its
  transcript — once it goes quiet past `stallTimeoutMs`. That is the only
  thing it does: it does not act on a stall or answer it.
- The CLI: `run`, `status`, `switch`, `resume`, `doctor`.
- Both plugins install into their host. Their built bundles
  (`plugins/*/capo/dist/capo.mjs`) are committed to the repository rather
  than gitignored, so a fresh checkout has what a marketplace install needs.

A full run has been watched work end to end on live Codex — two coordinators,
two worktrees, two results, a merge, a passing combined check, and a clean
exit. See [notes/first-complete-run.md](notes/first-complete-run.md), which
also records what that run got wrong.

**The largest thing not done: no real usage limit has ever fired.** Detection,
checkpoint, switch and relaunch are exercised against captured fixtures and
real CLI output shapes, never against a live cap — the one scenario CAPO was
built for.

**Not verified:**

- No real usage limit has fired on either platform. Claude Code's detection
  now reads a structured event confirmed to exist in the installed CLI's own
  schema, but the `"rejected"` status that would actually trigger it has
  never been observed live. Codex's detection is still message-pattern
  matching; its real wire shape for a limit remains an educated guess.
- Codex has never completed a full orchestration — only single turns and one
  hand-forced platform switch.
- A coordinator assigned more than one task still runs in the shared
  workspace rather than an isolated worktree; only the one-task case is
  isolated.
- `roles/worker.md` and the worker model column are validated by config and
  handed to each coordinator to relay in its prompt, but CAPO never spawns a
  worker itself — coordinators do, using their host's native subagent
  mechanism — so this path has no test that actually launches a worker.
- Installing straight from GitHub with no local clone should work now that
  bundles are committed, but nobody has run it end to end yet.

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
    driver: codex

start_on: claude

models:            # role -> platform -> model (names illustrative; use each CLI's real IDs)
  root:
    claude: opus
    codex: <your codex model>
  coordinator:
    claude: sonnet
    codex: <your codex model>
  worker:
    claude: haiku
    codex: <your codex model>

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
state, and write scope, rendered as a fenced JSON block so it round-trips
exactly. Each pause writes a numbered set directory containing one file per
session plus an `INDEX.md` naming the reason for the pause (usage-limit,
user-switch, both-capped, stop), the platform the sessions were running on, and
every session file in the set.

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
    transcripts/<session>.md # live, human-readable log of each session
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

## Seeing what is happening

CAPO drives its sessions headlessly, with `claude -p` and `codex exec`. That is
what makes a control channel possible: CAPO can ask a session for a checkpoint
at any moment and read the reply. The cost is that the sessions appear in no
host's session list and there is no window to open. Without help you are paying
for several agents to work and can see none of them.

Interactive mode is not an alternative. Claude Code's `--bg` returns
immediately and gives up the streaming channel, so CAPO could no longer request
a checkpoint, which is the one thing it must be able to do.

So the sessions stay headless and everything they emit is mirrored to disk:

- `transcripts/<session>.md`, appended as events arrive. `tail -f` shows the
  work in real time, and the file remains afterwards. A header marks each
  launch with its platform and model, so a transcript that spans a switch
  shows exactly where the session moved. A usage limit is called out in the
  transcript along with what CAPO is doing about it. On by default; set
  `transcripts: false` in the config to turn it off.
- `STATUS.md`, rebuilt on every state change: sessions, tasks, limits seen, and
  whether the run is parked waiting for a reset.
- `capo status`, which prints the same and each session's platform session id.

That last one is a handle, not just a label. For Claude Code it is the
`--session-id` CAPO generated, so the conversation is a real stored session.

## Platform adapters

Two adapters, both in-process, both driven through their vendor's documented
programmatic surface:

- **Claude Code**: headless JSON event mode with session IDs and explicit
  resume. Native subagents via the Agent tool.
- **Codex**: `codex exec --json` for a turn, `codex exec resume` to continue.
  One turn per process, so a session owns a sequence of children behind one
  event stream. Native subagents via Codex's subagent support. The `app-server`
  surface is the eventual target and is scaffolded behind the same adapter, but
  v0.1 does not use it: it is marked experimental, and `exec` is enough for
  prompt in, event stream out.

Each adapter must do four things: start a session with a role, model, and
initial prompt; send a message; stream events; and report a **usage limit** as
a structured event with a reset time when the platform provides one. Limit
detection is the one adapter feature v0.1 cannot ship without. Claude Code's
mapping now comes from a real captured stream rather than a guess (see
above); Codex's still needs a live test against an actual limit, not only a
fixture.

Approvals and questions from a session are not surfaced anywhere. There is no
approval channel: a session that stalls waiting for one is only marked
`stalled` by the watchdog above and left there. A live Codex run hit this
directly — a coordinator diagnosed its bug, asked for approval to apply the
fix, and then sat idle with no way for a person to answer it through CAPO.
Surfacing and answering approvals from the CAPO terminal is unbuilt.

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

A coordinator reports a task done with its worktree commit and test evidence,
as a fenced `# Result:` block. CAPO never asks for one — a coordinator sends
it unprompted whenever the work is finished and committed, so every piece of
a session's text output is checked for one.

A coordinator's own report never by itself marks a task done. CAPO takes from
it only the two facts the session alone knows — the commit and the evidence
narrative — and stamps the task id and base commit from its own task table,
for the same reason a live session once returned a perfectly well-formed
checkpoint with every identity field blank.

Once every task has reported, CAPO integrates:
`acceptResult` re-checks each commit against that task's base and declared
write scope and rejects anything that wrote outside it; surviving results are
merged one at a time into an integration worktree; `check_command` runs once
over the combined tree. Merged tasks become `done`, rejections and conflicts
become `failed`, and the run is `done` only if nothing was rejected, nothing
conflicted, and the check passed.

The root does not perform any of this. It is mechanical, it belongs to the
orchestrator, and a root told to do it by hand will do it in the shared
workspace, outside every write scope — which is exactly what happened the
first time a run finished.

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

Installed CLI versions observed: Codex 0.147.0 and 0.154.0; Claude Code
2.1.236. Both platforms have now had authenticated agent runs against the
real CLI, not only presence and help-output checks — see
[notes/codex-live-findings.md](notes/codex-live-findings.md) for Codex and
`packages/core/src/adapters/claude.ts` / `__fixtures__/README.md` for Claude
Code.

- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex subagents: https://learn.chatgpt.com/docs/agent-configuration/subagents
- Claude programmatic sessions: https://code.claude.com/docs/en/headless
- Claude native subagents: https://code.claude.com/docs/en/sub-agents
- Claude plugin packaging: https://code.claude.com/docs/en/plugins-reference
- Codex plugin authoring: https://learn.chatgpt.com/docs/build-plugins
