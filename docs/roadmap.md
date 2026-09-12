# CAPO — Concurrent Agent Platform Orchestrator

Status: full design, kept as the roadmap. The v0.1 scope is in architecture.md.
Date: 2026-09-12.

## Product

A platform-neutral local orchestration framework exposed through a CLI, MCP, and optional platform plugin bundles. One root agent plans and integrates work. A configurable set of coordinator sessions delegates bounded tasks through installed platform adapters. The initial configuration has two coordinators, Claude Code and Codex, on the same machine, as confirmed by the user. This is a starting configuration, not a fixed topology. Future platforms such as Gemini must be addable without modifying the scheduler, ownership rules, persistence schema, or handoff protocol.

CAPO stands for Concurrent Agent Platform Orchestrator. Its project home is `/home/user/Desktop/CAPO`. All CAPO design documents, implementation, examples, packaging, and tests belong there. CAPO should become an independent open-source repository; public repository owner and final release metadata remain release decisions, not runtime dependencies.

## Approach selection

1. Recommended: config-driven local runtime with Markdown context, a single-writer file journal, platform adapters, and thin plugins. No database dependency in v0.1. All platforms use the same ownership and messaging protocol while preserving native agents and tools.
2. Multiple agents directly editing shared Markdown status files would be simpler initially, but provides no reliable arbitration of simultaneous claims or interrupted transfers. Use Markdown for knowledge and readable status, with runtime-controlled execution state.
3. A database-backed or distributed service may become useful for multiple machines, multiple writers, or large query workloads. Those are outside v0.1. Keep storage behind an internal interface so adapters and the agent protocol do not depend on the storage format.

## Roles and runtime

- Root: owns the objective, dependency graph, shared interface decisions, task assignments, and final integration. Only one active root authority is allowed per run.
- Coordinators: dedicated platform sessions registered by configurable coordinator ID and adapter ID; subdivide assigned work and report results and blockers. Multiple coordinators may use the same adapter. The root and coordinator roles are independent of platform identity.
- Workers: agents registered against a task, attempt, adapter, platform session, and assigned worktree. A worker receives the task's relevant context and artifact references. The initial adapters use native subagents; additional adapters declare their actual execution capabilities.
- Local service: deterministic authority for task transitions, ownership, messages, process supervision, and acceptance of results. It is not another reasoning agent.

Use TypeScript for the initial CLI, service, MCP interface, and bundled adapters. Persist state in local files as specified below; no SQLite or other database is required. TypeScript is an implementation choice, not an integration requirement. Third-party adapters may be written in any language and communicate through a versioned JSON protocol over stdio. Use one service per project registry, with per-session stdio MCP bridges connecting to it through authenticated local IPC. Multiple plugin instances must not create competing authorities. Store runtime data outside plugin caches and exclude it from source distributions.

## Configuration and session initialization

The execution entry point accepts a YAML or JSON config file. Proposed CLI: `capo run --config ./orchestration.yaml`. `capo init --config` validates configuration and prepares the session directory without model calls; `capo run --config` performs initialization if necessary and then launches the configured agents. `capo resume <run-id>` uses the recorded effective configuration and must not silently reinterpret an edited source config. Installed plugins expose these same operations through their skills and MCP tools, so users can start and manage a run from either host conversation.

Configuration declares schema version, workspace, objective or objective file, adapter registrations, root identity/role, a list of coordinators, worker templates and spawn policy, shared context sources, initial tasks, dependencies, ownership scopes, concurrency, and timeouts. Provider configuration remains adapter-owned and extensible. Resolve relative paths against the config directory. Parse YAML as data only, reject duplicate IDs, unknown core keys, missing references, dependency cycles, out-of-workspace write scopes, and overlapping initial claims before launching agents. Credentials are resolved through the adapter's normal authentication or explicit environment references; never embed resolved secrets in the recorded config.

Illustrative proposed config (referenced documents are supplied by the project):

```yaml
version: 1
workspace: .
objective_file: ./context/GOAL.md

adapters:
  claude:
    driver: claude-code
  codex:
    driver: codex-app-server

context:
  shared:
    - ./context/PROJECT.md
    - ./context/CONTRACTS.md

root:
  id: root
  adapter: codex
  instructions: ./roles/root.md

coordinators:
  - id: team-a
    adapter: claude
    instructions: ./roles/coordinator.md
    workers:
      mode: native
      max_concurrent: 2
      instructions: ./roles/worker.md
      spawn: on_task_ready
  - id: team-b
    adapter: codex
    instructions: ./roles/coordinator.md
    workers:
      mode: native
      max_concurrent: 2
      instructions: ./roles/worker.md
      spawn: on_task_ready

tasks:
  - id: component-a
    coordinator: team-a
    brief: ./tasks/component-a.md
    write_scope: [src/component-a/]
  - id: component-b
    coordinator: team-b
    brief: ./tasks/component-b.md
    write_scope: [src/component-b/]

limits:
  max_active_workers: 4
```

Task briefs must supply an objective and acceptance checks. Initial tasks with no dependencies become ready after validation, so both example coordinators receive immediate native-worker assignments. Empty task lists are allowed: the root decomposes the objective first and workers start as those tasks become ready. Coordinators can propose additional bounded tasks and workers under the configured limits; every spawn requires a registered task/attempt and a runtime reservation before editing begins. Each adapter must demonstrate how its native spawn path honors that reservation, or report the managed-delegation capability unavailable. Failed or uncertain spawn acknowledgements retain a reconcilable reservation rather than triggering blind retries. Global worker limits and per-coordinator limits both apply; root and coordinator sessions are reported separately.

Startup sequence: validate config and referenced files; acquire the project runtime lock or connect to its existing owner; snapshot the effective config and context; negotiate adapter capabilities; start the root and coordinator sessions; register initial tasks and claims; dispatch ready tasks for native worker spawning. Persist an operation ID before each platform launch and reconcile uncertain outcomes on recovery. Repeating a resume or retry must not duplicate successful launches. Starting a new run is explicit; cross-run write claims are also arbitrated by the project runtime.

## Shared context and file-based state

Use Markdown for project knowledge and agent-facing context. Use structured JSON for machine state. Suggested project layout:

```text
orchestration.yaml             # version-controlled team setup
roles/                        # version-controlled role instructions
context/                      # version-controlled project knowledge
  GOAL.md
  PROJECT.md
  CONTRACTS.md
.capo/                        # local, gitignored runtime data
  runtime.lock                # single writer ownership
  journal.jsonl               # authoritative project events across runs
  state.json                  # rebuildable snapshot with event sequence
  runs/<run-id>/
    config.resolved.json      # frozen effective config; secret references only
    context/                  # immutable captured versions + generated INDEX.md
    tasks/<task-id>/BRIEF.md
    notes/<agent-id>/          # agent-owned drafts and findings
    handoffs/<handoff-id>.md
    STATUS.md                 # generated readable view of execution state
```

Context has explicit ownership. The root curates shared decisions and contracts. Coordinators and workers submit findings from their own notes; they request shared-context updates through the runtime with an expected revision. The runtime rejects stale revisions rather than overwriting another update. Source context files are inputs snapshotted at initialization; editing them during a run takes effect only through an explicit context-import/update operation. Agents do not silently receive changing files under the same revision.

Publish context bodies as immutable versioned Markdown files first, then record their hash and revision in the journal. A committed event makes the new revision authoritative. Generated Markdown views can be rebuilt. A crash before the event may leave an unreferenced file, which is harmless; a referenced file that is missing or has a mismatched hash is a recovery error. Treat a multi-document context update as one event referencing the complete set of revisions.

At dispatch, each worker receives the objective, role instructions, task brief and ownership boundaries, current relevant contracts/decisions, and a short index of other documents. Record the exact revisions used by each attempt. Load additional relevant files on demand rather than copying every agent transcript into every prompt. Summaries retain source links and unresolved questions. Contract changes notify affected tasks; the root decides whether to rebase or restart work based on the old version. A Markdown handoff body carries the readable checkpoint; the corresponding journal events remain authoritative for transfer ownership and acknowledgement.

Only the runtime writes authoritative execution state. Agents submit commands through MCP/CLI; they never claim work by directly changing JSON or Markdown. Use one serialized mutation queue across every client connection. Validate a command against current state, append a complete sequenced event with a stable command ID, flush it to disk, apply the transition in memory, and then acknowledge it. A claim release/acquisition or handoff ownership switch is represented by one event, preventing partial multi-file transitions. Platform side effects use recorded operation IDs and a separate outcome event; file persistence cannot guarantee exactly-once external execution.

Periodically produce a checksummed snapshot with its last applied sequence using a temporary file and replacement in the same directory. The journal remains authoritative; keep the full journal in v0.1 and avoid a compaction protocol. On restart, validate the snapshot or rebuild it, replay later complete events, deduplicate command IDs, and reconcile platform processes before accepting new mutations. An incomplete final journal record may be quarantined and the valid prefix recovered; corruption within the committed prefix stops recovery rather than silently skipping events. Test crashes before/after event flush and before/after acknowledgement. Power-loss durability depends on filesystem sync semantics and must be tested on supported filesystems; atomic replacement alone does not establish durability.

Acquire the writer lock with exclusive local file creation and record an owner token, PID, and process identity. A second process connects to the live owner or refuses to start. Never steal the lock based on age or heartbeat alone. If ownership cannot be proven dead, refuse takeover; any stale-lock cleanup must itself be serialized so concurrent recovery attempts cannot remove a new owner's lock. MVP storage is on a supported local disk, not an NFS or cloud-synchronized shared directory. Node documents that concurrent file modifications are not synchronized and exclusive file flags may not work on network filesystems: https://nodejs.org/api/fs.html.

This removes a database dependency while retaining the small amount of state machinery needed for reliable ownership and recovery. A future remote backend can implement the same command/event contract without changing agent adapters.

## Extensible adapter contract

Platform IDs are open strings registered through adapter manifests, never a closed Claude/Codex/Gemini enum. Configuration selects the root adapter and a list of coordinators. The core must not contain provider-name conditionals or require schema migrations to register a provider.

An adapter manifest declares its ID, adapter version, supported protocol versions, executable and argument list, and configuration schema. Launch configured executables directly, without constructing interpolated shell commands. Registration is explicit; do not execute arbitrary adapters discovered in a project. Provider-specific configuration is validated by its adapter, while the core validates common protocol and ownership fields.

The baseline protocol covers initialize/capability discovery, start session, submit input, observe events/status, request cancellation, and close. Messages have request IDs and correlated responses. Cancellation acceptance is distinct from confirmed termination. Session IDs are opaque strings to the core.

Optional capabilities include native subagents, persistent resume, mid-turn steering, forked sessions, worktree isolation, usage reporting, and interactive approvals. Negotiate capabilities at startup and record the effective set per session; installed version, authentication, and policy can change what is actually available. Unsupported operations return explicit structured errors. The scheduler routes work by required capabilities instead of provider identity.

For a platform without native subagents, an explicitly configured separate-session worker mode may be offered when its adapter supports it. Report that mode accurately; never present independent sessions as native children. Tasks requiring native delegation must use a capable adapter or remain visibly blocked. Hints can queue until the next input boundary when live steering is unavailable.

Keep a small validated common message envelope: protocol version, message ID, kind, run/task/attempt references, sender/recipient, and payload. Provider-specific data belongs in namespaced extension fields and is opaque to the core. Third-party informational event kinds may be registered without changing the core; unknown extensions must not grant authority or drive task state transitions. Incompatible protocol versions fail negotiation. Validate the stable contract at runtime with JSON Schema; extensibility does not remove checks on ownership, fencing, or result acceptance.

Handoffs contain portable checkpoints and artifact references, with optional namespaced metadata. They must not require transferring a provider's private transcript format, hidden reasoning, or internal session state. The target reconstructs working context from the portable checkpoint.

## Initial platform adapters

Codex: use App Server over stdio for session start/resume, streaming events, steering active turns, interrupting turns, and surfacing approval requests. Treat protocol changes as versioned adapter concerns.

Claude: use Claude Code's programmatic JSON event mode with session IDs and explicit resume. Use its native Agent tool for subagents. Queue hints for delivery at safe turn boundaries in the baseline implementation; only promise mid-turn delivery when supported and tested by the selected adapter.

Coordinators are top-level platform sessions, regardless of which platform hosts the root. Do not depend on a native cross-provider parent/child relationship. Keep platform permission controls in force and route requests needing a person back to the root's user interface. Gemini is a future adapter target, not a verified integration in this proposal.

## Parallel work and ownership

Every task declares an objective, acceptance checks, dependencies, file/directory write scope, named shared resources, and assigned coordinator. All participants may read shared source snapshots. Each coding worker receives a separate worktree from a recorded base commit.

The service grants exclusive write claims atomically. Normalize repository-relative paths, detect parent/child directory overlap, and reject claims outside the repository. Shared contracts, migrations, lockfiles, and other cross-cutting resources must have explicit owners. Coordinators may subdivide their allocation, but child scopes must remain within it and sibling write claims cannot overlap.

Claims have an owner, attempt number, expiry, and fencing token. Heartbeats renew ownership. Expiry fences the old attempt immediately; replacement work uses a fresh worktree and cannot accept results bearing the old token. Stop or quarantine the previous process before reusing its workspace. An expired lease alone does not prove an agent has stopped writing.

These are coordination and integration guarantees, not a filesystem security boundary. Worktrees isolate edits; hooks and platform restrictions help catch invalid writes early. Independently inspect each submitted diff against its approved scope, including renamed paths, and reject out-of-scope results. Semantic overlap still requires root judgment and integration tests.

## Hints and handoffs

Standard message kinds: hint, question, blocker, contract-change proposal, handoff offer, handoff acceptance, result, cancellation. Each message carries an ID, sender, recipient, task/attempt references, causal reference, and acknowledgement state. These share the extensible protocol envelope described above. Persist before delivery; retries use the same ID and receivers deduplicate.

A hint shares information without transferring ownership. Example: a worker discovers an existing helper and sends its file reference to the other coordinator. Delivery and acknowledgement are distinct from acting on the hint.

A handoff transfers responsibility. Freeze the source attempt and collect a checkpoint: objective, decisions, remaining work, base/result commit or patch, changed files, test evidence, and blockers. After the source has stopped and the target has accepted, atomically transfer ownership and mint a new fencing token. If delivery fails, the task remains visibly awaiting transfer; do not start two owners. Serialize competing handoff offers and reject stale acknowledgements.

Task states: pending, ready, running, blocked, handing-off, review, completed, failed, cancelled. Dependencies unlock only after accepted results are integrated. Attempts have separate identities so retries never overwrite prior evidence.

## Integration and recovery

Workers submit results with their attempt identity, fencing token, artifact hash, exact base and result commits, and validation evidence. The root integrates accepted changes one at a time into an integration worktree, checks conflicts, and runs the combined acceptance checks. A worker's completion report alone cannot mark the run successful.

After restart, reconcile saved platform session IDs, process state, leases, pending messages, and integration state before scheduling more work. Duplicate delivery must not cause duplicate tasks, ownership transfers, or integration. Unknown platform outcomes require reconciliation rather than blind relaunch. Rate limits and permissions produce explicit blocked/retryable states. Set configurable concurrency, timeout, retry, and available usage limits; do not invent cost values when a platform omits them.

## Plugin and open-source package

One independent source repository contains the provider-neutral protocol/runtime, CLI, adapter SDK and conformance suite, bundled adapters, and initially two installable plugin bundles. Runtime adapters and platform-facing plugin packaging are separate extension points: adding a platform must not require that platform to have a native plugin system. Platforms may integrate through their supported CLI, SDK, or MCP surfaces as appropriate. The Claude bundle uses its .claude-plugin manifest; the Codex bundle uses .codex-plugin/plugin.json. Each includes relevant skills, role instructions, MCP configuration, and supported hooks. Plugin metadata and setup instructions are tested separately on each platform. Publish documentation for implementing and independently distributing adapters.

### Plugin-first installation and user experience

The main product is CAPO installed into Codex and Claude Code. The standalone CLI supports automation and diagnostics, and backs the same runtime operations used by the plugins. A user should not have to maintain a manually configured MCP server separately after installing the CAPO plugin.

Ship distinct host-specific plugin bundles with the same CAPO identity and shared protocol. Each bundle includes its host manifest, MCP bridge configuration, root/coordinator/worker skills or role definitions supported by that host, and the required versioned runtime assets. Build self-contained JavaScript distributions including dependencies where practical; document and check the supported Node runtime and platform CLIs as prerequisites. Installation must not rely on the development checkout or global package downloads on every session. A plugin bridge resolves assets relative to its installed plugin root and connects to the project runtime. Both hosts must attach to one compatible project runtime, even when each uses a different plugin cache location. Reject incompatible runtime/protocol versions with an actionable diagnostic.

Proposed repository organization:

```text
CAPO/
  README.md
  LICENSE
  docs/
    architecture.md
    installation-codex.md
    installation-claude.md
    adapter-development.md
  packages/
    protocol/
    runtime/
    cli/
    adapters/
      claude-code/
      codex-app-server/
  plugins/
    codex/capo/
      .codex-plugin/plugin.json
      .mcp.json
      skills/
      dist/
    claude/capo/
      .claude-plugin/plugin.json
      .mcp.json
      skills/
      agents/
      dist/
  examples/
    two-platform-team/
  tests/
    protocol/
    runtime/
    installation/
```

Distribution includes the host-specific marketplace metadata and versioned release bundles. Generate and validate each platform's metadata using that platform's supported schema. Document actual install commands and repository URLs once the public repository identity is resolved and the commands have been verified. Keep development installation and public marketplace installation clearly distinguished; local loadability alone does not establish a working public install.

Intended user journey:

1. Install CAPO through Codex's plugin mechanism and Claude Code's plugin mechanism using the release's supported marketplace/package path.
2. Complete host-required plugin/MCP trust steps and authenticate the platform CLIs normally. Restart or reload sessions when the host requires it.
3. From either host, invoke the CAPO setup skill with a project config file. It checks prerequisites, resolves the target project, validates adapters and roles, and prepares `.capo/` in that target project.
4. Invoke CAPO run through the plugin. The selected host conversation can attach as root when the adapter supports it; otherwise start the config-selected managed root session. Record the choice explicitly to avoid creating two roots. The root uses the shared runtime to start coordinator sessions and manage native worker delegation.
5. Use CAPO status, hint, handoff, resume, and cancel tools from either host. The second host joins the existing runtime and session registry instead of duplicating the team. Auto-launched coordinator sessions must load their CAPO tools and role instructions deterministically, independent of user-global defaults.

The initial release must verify fresh installation on both hosts, discovery of CAPO skills and MCP tools, configuration-driven startup from each plugin, shared-runtime attachment, coordinator access to native delegation and CAPO tools, restart/resume, and plugin-version mismatch handling. Disabling or uninstalling a host plugin must not silently delete project context or run history; stopping active managed sessions is an explicit runtime operation. Public release requires testing clean installs from the built artifacts, not only from source directories.

Proposed CLI surface: init, doctor, run, status, events, resume, cancel, context update. Proposed MCP surface covers task creation/claiming, delegation registration, heartbeats, inbox/acknowledgements, hints, context read/propose/update, handoff offer/accept, result submission, and integration status. Mutations authenticate the caller's session identity and role rather than accepting an arbitrary actor ID from the model.

Prepare a permissive license choice (proposed Apache-2.0), README led by Codex and Claude plugin installation, protocol specification, contribution guide, security reporting instructions, CI, and a reproducible demo. Release only framework sources and synthetic examples; runtime conversations and unrelated workspace code are not package inputs. Validate a clean install from a release artifact before public release.

## Acceptance demonstration

Start one root and both coordinators against a synthetic repository. Have each coordinator spawn at least one native worker and complete independent changes concurrently. Exchange a hint, then hand a stopped task from Claude to Codex and finish it. Integrate and test the combined result.

Also verify competing claims, overlapping parent/child paths, stale worker completion, coordinator termination, service restart, repeated message delivery, failed handoff, cancellation, and out-of-scope changes. Use deterministic fake platform adapters for fault tests, plus live opt-in tests for genuine native delegation. Do not describe fake-adapter coverage as a live cross-platform test.

Prove extensibility with an independently registered third fixture adapter implemented outside the TypeScript adapter SDK. Run it through the stdio contract without core edits or a storage migration. Test a configurable third coordinator, two coordinators using one provider, opaque string session IDs, missing optional capabilities, namespaced extension payloads, incompatible protocol versions, and portable cross-adapter handoffs. The fixture demonstrates protocol portability, not Gemini support. A real Gemini adapter needs its own capability verification and live acceptance run before being advertised.

Verify config-driven initial worker spawning, dynamic task spawning, reserved concurrency limits, invalid config rejection before launch, frozen config on resume, and uncertain launch reconciliation. Exercise concurrent runtime startup, competing claims across runs, torn journal tails, invalid snapshots, conflicting context revisions, immutable context references on handoff, and generation of readable status from replayed state. Test platform-managed spawns against configured limits in live runs, not only against fixture adapters.

## Verified integration references

Installed CLI versions observed: Codex 0.147.0; Claude Code 2.1.236. Presence and help output were checked; authenticated agent runs have not been tested.

- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Codex subagents: https://learn.chatgpt.com/docs/agent-configuration/subagents
- Codex plugin authoring: https://learn.chatgpt.com/docs/build-plugins
- Claude programmatic sessions: https://code.claude.com/docs/en/headless
- Claude native subagents: https://code.claude.com/docs/en/sub-agents
- Claude plugin packaging: https://code.claude.com/docs/en/plugins-reference
