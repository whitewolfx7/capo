/**
 * The orchestrator: launches a run's sessions on the active platform, watches
 * their event streams, and on a usage limit checkpoints the whole team and
 * relaunches it on the other platform. This is the state machine described
 * in docs/architecture.md, "The rule".
 */
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AdapterEvent,
  AdapterSession,
  CapoConfig,
  Checkpoint,
  CheckpointSet,
  PauseReason,
  PlatformAdapter,
  PlatformId,
  RoleName,
  RunState,
  SessionId,
  StartSessionOptions,
  TaskRecord,
} from '../types.js';
import type { StateStore } from '../state/store.js';
import { latestCheckpointSet, writeCheckpointSet } from '../checkpoint/store.js';
import { renderStatusMarkdown } from '../state/status-md.js';
import {
  appendTranscript,
  renderEvent,
  renderSessionHeader,
  renderStallClearedNotice,
  renderStallNotice,
} from './transcript.js';
import { parseCheckpoint } from '../checkpoint/render.js';
import { headCommit, addWorktree } from '../git/repo.js';
import { buildSystemPrompt, CHECKPOINT_REQUEST, extractCheckpoint } from './prompt.js';

const CHECKPOINT_TIMEOUT_MS = 60_000;

export interface OrchestratorOptions {
  config: CapoConfig;
  runDir: string;
  state: StateStore;
  adapters: Map<PlatformId, PlatformAdapter>;
  log?: (line: string) => void;
  /**
   * How often the stall watchdog polls (see `#checkStalls`). Not a config
   * file setting — `config.stallTimeoutMs` is the threshold a person cares
   * about; this is purely how finely the orchestrator samples for it.
   * Defaults to 1s, which is fine against a real `stallTimeoutMs` measured in
   * minutes. Tests pass a smaller value so they don't have to wait minutes.
   */
  stallPollMs?: number;
}

interface LiveSession {
  session: AdapterSession;
  role: RoleName;
  platform: PlatformId;
}

export class Orchestrator {
  readonly events: EventEmitter = new EventEmitter();

  readonly #config: CapoConfig;
  readonly #runDir: string;
  readonly #state: StateStore;
  readonly #adapters: Map<PlatformId, PlatformAdapter>;
  readonly #log: (line: string) => void;

  readonly #live = new Map<SessionId, LiveSession>();
  readonly #pending = new Map<SessionId, (cp: Checkpoint) => void>();

  // Stall watchdog bookkeeping. `#lastEventAt` and `#stalledSet` are kept
  // in-memory only and rebuilt from `#live` as sessions launch and close --
  // unlike everything reached through `#update`, they are not part of
  // `state.json`. Writing state on every single event (some sessions emit
  // many per second) would turn "watch for silence" into the very thing that
  // slows a run down; only the rarer stalled/cleared transitions are
  // persisted, by `#checkStalls` and `#onEvent` respectively.
  readonly #lastEventAt = new Map<SessionId, number>();
  readonly #stalledSet = new Set<SessionId>();
  readonly #stallPollMs: number;
  #stallTimer: NodeJS.Timeout | undefined;

  #switching = false;

  constructor(opts: OrchestratorOptions) {
    this.#config = opts.config;
    this.#runDir = opts.runDir;
    this.#state = opts.state;
    this.#adapters = opts.adapters;
    this.#log = opts.log ?? (() => {});
    this.#stallPollMs = opts.stallPollMs ?? 1000;
    this.events.setMaxListeners(0);
    this.#startStallWatch();
  }

  /**
   * Resolves the workspace's HEAD, records it as the run's base commit,
   * creates a git worktree per configured task, seeds `state.tasks`, then
   * launches every session on `config.startOn`.
   */
  /**
   * Every state change goes through here so `STATUS.md` is refreshed with it.
   *
   * CAPO's sessions are headless: they appear in no host's session list and
   * there is no window to open. Without a generated view, the only way to see
   * what a run is doing is to read raw JSON.
   */
  async #update(fn: (draft: RunState) => void): Promise<RunState> {
    const next = await this.#state.update(fn);
    try {
      await writeFile(join(this.#runDir, 'STATUS.md'), renderStatusMarkdown(next), 'utf8');
    } catch {
      // A view is never worth failing a run over.
    }
    return next;
  }

  async start(): Promise<void> {
    const base = await headCommit(this.#config.workspace);

    const taskRecords: TaskRecord[] = [];
    for (const task of this.#config.tasks) {
      const worktree = join(this.#runDir, 'worktrees', task.id);
      // Scoped to the run, not just the task. Branches outlive `.capo/`, so a
      // second run in the same repository (or a retry after a failed one)
      // would hit "a branch named 'capo/task-a' already exists" and the
      // orchestrator would die before launching anything.
      const branch = `capo/${this.#state.get().runId}/${task.id}`;
      await addWorktree(this.#config.workspace, worktree, branch, base);
      taskRecords.push({
        id: task.id,
        coordinator: task.coordinator,
        briefPath: task.brief,
        writeScope: task.writeScope,
        state: 'ready',
        worktree,
        branch,
        baseCommit: base,
      });
    }

    await this.#update((draft) => {
      draft.baseCommit = base;
      for (const record of taskRecords) draft.tasks[record.id] = record;
    });

    await this.#launchAll(this.#config.startOn);
  }

  /**
   * Continues a run whose orchestrator process is gone: after a crash, a
   * closed laptop, or a wait for both platforms to reset.
   *
   * This is the difference between CAPO working and CAPO losing your work.
   * Checkpoints are written to disk on every pause, but nothing read them
   * back: a relaunch with no checkpoint would start every session with no
   * memory of what it had done, while the file describing exactly that sat
   * unused next to it. So resume loads the latest checkpoint set and hands
   * each session its own.
   *
   * Unlike `start()` this does NOT create worktrees. They already exist from
   * the original launch, and `git worktree add` over an existing path fails.
   *
   * Returns the checkpoint set index it resumed from, or undefined when the
   * run had never paused and there was nothing to resume from.
   */
  async resume(): Promise<number | undefined> {
    const state = this.#state.get();
    const platform = state.activePlatform;

    const set = await latestCheckpointSet(this.#runDir);
    if (!set) {
      // A run that died before its first pause. Nothing to restore, so launch
      // clean rather than refusing: the tasks and worktrees still stand.
      await this.#launchAll(platform);
      return undefined;
    }

    const checkpoints = new Map<SessionId, Checkpoint>();
    for (const checkpoint of set.checkpoints) {
      checkpoints.set(checkpoint.sessionId, checkpoint);
    }

    await this.#update((draft) => {
      draft.status = 'running';
      // Drop limit records that are no longer in the future, including ones
      // whose reset time the platform never told us. Those are treated as
      // capped indefinitely, which is the right default for automatic
      // scheduling but would otherwise make a run unresumable forever. A
      // person running `capo resume` is asserting the platform is usable now.
      for (const [id, limit] of Object.entries(draft.limits)) {
        const stillCapped =
          limit.resetAt !== undefined && new Date(limit.resetAt).getTime() > Date.now();
        if (!stillCapped) delete draft.limits[id];
      }
    });
    await this.#launchAll(platform, checkpoints);
    this.events.emit('resumed', { index: set.index, platform });
    return set.index;
  }

  /**
   * A hand-forced switch (`capo switch`). Checkpoints and closes every live
   * session, then relaunches on `to` (or, if `to` is undefined, on whichever
   * other declared platform is not currently capped). A switch already in
   * flight makes this a no-op: two switches never run concurrently.
   */
  async requestSwitch(to: PlatformId | undefined, reason: PauseReason): Promise<void> {
    if (this.#switching) return;
    this.#switching = true;
    try {
      await this.#doSwitch(to, reason);
    } finally {
      this.#switching = false;
    }
  }

  /** Checkpoints and closes every live session and ends the run. Does not relaunch. */
  async stop(reason: PauseReason = 'stop'): Promise<void> {
    if (this.#switching) return;
    this.#switching = true;
    try {
      const checkpoints = await this.#checkpointAndCloseAll(reason);
      await this.#update((draft) => {
        draft.status = 'done';
        for (const sessionId of checkpoints.keys()) {
          const record = draft.sessions[sessionId];
          if (record) record.status = 'stopped';
        }
      });
      this.#stopStallWatch();
    } finally {
      this.#switching = false;
    }
  }

  async #doSwitch(to: PlatformId | undefined, reason: PauseReason): Promise<void> {
    const fromPlatform = this.#state.get().activePlatform;
    const checkpoints = await this.#checkpointAndCloseAll(reason);

    const target = to ?? this.#pickTarget(fromPlatform);
    if (target === undefined) {
      await this.#update((draft) => {
        draft.status = 'waiting';
      });
      this.events.emit('waiting');
      return;
    }

    await this.#update((draft) => {
      draft.activePlatform = target;
    });
    await this.#launchAll(target, checkpoints);
    await this.#update((draft) => {
      draft.status = 'running';
    });
    this.events.emit('switched');
  }

  /** The other declared platform that is not currently capped, excluding `exclude`. */
  #pickTarget(exclude: PlatformId): PlatformId | undefined {
    const state = this.#state.get();
    const candidates = Object.keys(this.#config.platforms).filter((p) => p !== exclude);
    return candidates.find((p) => !this.#isCapped(state, p));
  }

  #isCapped(state: RunState, platform: PlatformId): boolean {
    const limit = state.limits[platform];
    if (!limit) return false;
    if (!limit.resetAt) return true;
    return new Date(limit.resetAt).getTime() > Date.now();
  }

  /**
   * Sends `CHECKPOINT_REQUEST` to every live session and collects replies
   * (60s per-session timeout; a session that never answers gets a minimal
   * checkpoint synthesized from state, so it can never block the switch).
   * Increments `pauseCount`, writes the checkpoint set, then closes every
   * session. Returns the collected checkpoints, keyed by session id.
   */
  async #checkpointAndCloseAll(reason: PauseReason): Promise<Map<SessionId, Checkpoint>> {
    await this.#update((draft) => {
      draft.status = 'switching';
    });

    const entries = [...this.#live.entries()];
    const results = new Map<SessionId, Checkpoint>();

    await Promise.all(
      entries.map(async ([sessionId, live]) => {
        const cp = await this.#requestCheckpoint(sessionId, live, reason);
        results.set(sessionId, this.#stampCheckpoint(sessionId, live, cp));
      }),
    );

    const stateAfterIncrement = await this.#update((draft) => {
      draft.pauseCount += 1;
    });

    const set: CheckpointSet = {
      index: stateAfterIncrement.pauseCount,
      reason,
      platform: stateAfterIncrement.activePlatform,
      written: new Date().toISOString(),
      checkpoints: [...results.values()],
    };
    await writeCheckpointSet(this.#runDir, set);

    await Promise.all(entries.map(([, live]) => live.session.close()));
    for (const [sessionId] of entries) {
      this.#live.delete(sessionId);
      this.#lastEventAt.delete(sessionId);
      this.#stalledSet.delete(sessionId);
    }

    return results;
  }

  /**
   * Starts the periodic scan that backs the stall watchdog. Idempotent, and
   * safe to call before any session ever launches: an empty `#live` just
   * means nothing to check yet. `.unref()`ed so a live orchestrator process
   * (or a test that never calls `stop()`) is never kept alive by this timer
   * alone.
   */
  #startStallWatch(): void {
    if (this.#stallTimer) return;
    const timer = setInterval(() => {
      void this.#checkStalls();
    }, this.#stallPollMs);
    timer.unref?.();
    this.#stallTimer = timer;
  }

  #stopStallWatch(): void {
    if (this.#stallTimer === undefined) return;
    clearInterval(this.#stallTimer);
    this.#stallTimer = undefined;
  }

  /**
   * The watchdog tick: any live, non-terminal session that has gone
   * `config.stallTimeoutMs` without emitting a single event gets marked
   * `stalled` in state, STATUS.md, `capo status`, and its own transcript.
   *
   * Deliberately the only thing this does. A stalled session is not touched,
   * interrupted, or switched away from — silence is a fact for a person to
   * act on, not a verdict CAPO reaches on its own. See `renderStallNotice`.
   */
  async #checkStalls(): Promise<void> {
    const timeout = this.#config.stallTimeoutMs;
    const now = Date.now();
    const state = this.#state.get();

    const newlyStalled: SessionId[] = [];
    for (const sessionId of this.#live.keys()) {
      if (this.#stalledSet.has(sessionId)) continue;
      const record = state.sessions[sessionId];
      if (!record || record.status === 'stopped' || record.status === 'failed') continue;
      const last = this.#lastEventAt.get(sessionId) ?? now;
      if (now - last >= timeout) newlyStalled.push(sessionId);
    }
    if (newlyStalled.length === 0) return;

    for (const sessionId of newlyStalled) this.#stalledSet.add(sessionId);
    const stalledAt = new Date().toISOString();
    try {
      // Runs off a timer, not off #pump()'s try/catch, so a failure here
      // (e.g. the run directory disappearing as the process winds down) must
      // be swallowed right here or it becomes an unhandled rejection instead
      // of the harmless miss a view being briefly stale would be.
      await this.#update((draft) => {
        for (const sessionId of newlyStalled) {
          const record = draft.sessions[sessionId];
          if (record) {
            record.stalled = true;
            record.stalledSince = stalledAt;
          }
        }
      });
    } catch (err) {
      this.#log(`stall watchdog: could not persist state: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const sessionId of newlyStalled) {
      this.#log(`[${sessionId}] stalled: no events for over ${Math.round(timeout / 1000)}s`);
      if (this.#config.transcripts) {
        void appendTranscript(this.#runDir, sessionId, renderStallNotice(timeout, this.#config.autonomy));
      }
    }
  }

  /**
   * Replaces a checkpoint's metadata with what CAPO already knows.
   *
   * A live Codex agent, asked for a checkpoint, returned a perfectly
   * well-formed block with every header field blank: run, role, platform,
   * written and base_commit were all empty. That is not misbehaviour. A
   * session has no reliable way to know its run id or the base commit, and
   * asking it to restate them invites a confident wrong answer.
   *
   * So the division is: the session supplies the narrative, which only it
   * knows, and CAPO supplies the facts, which only CAPO knows. Anything the
   * session says about identity is discarded rather than trusted.
   */
  #stampCheckpoint(sessionId: SessionId, live: LiveSession, cp: Checkpoint): Checkpoint {
    const state = this.#state.get();
    return {
      ...cp,
      sessionId,
      runId: state.runId,
      role: live.role,
      platform: live.platform,
      written: new Date().toISOString(),
      baseCommit: state.baseCommit,
    };
  }

  #requestCheckpoint(sessionId: SessionId, live: LiveSession, reason: PauseReason): Promise<Checkpoint> {
    return new Promise<Checkpoint>((resolve) => {
      let settled = false;

      const finish = (cp: Checkpoint): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pending.delete(sessionId);
        resolve(cp);
      };

      const timer = setTimeout(() => {
        finish(this.#synthesizeCheckpoint(sessionId, live, reason));
      }, CHECKPOINT_TIMEOUT_MS);

      this.#pending.set(sessionId, finish);

      live.session.send(CHECKPOINT_REQUEST).catch(() => {
        finish(this.#synthesizeCheckpoint(sessionId, live, reason));
      });
    });
  }

  #synthesizeCheckpoint(sessionId: SessionId, live: LiveSession, reason: PauseReason): Checkpoint {
    const state = this.#state.get();
    return {
      sessionId,
      runId: state.runId,
      role: live.role,
      platform: live.platform,
      written: new Date().toISOString(),
      baseCommit: state.baseCommit,
      objective: '(synthesized: this session did not reply to the checkpoint request in time)',
      decisions: [],
      done: [],
      inProgress: [],
      remaining: [],
      blockers: [`no reply before the checkpoint timeout (pause reason: ${reason})`],
    };
  }

  /** Starts the root, then every coordinator, on `platform`. Each gets only its own checkpoint, if any. */
  async #launchAll(platform: PlatformId, checkpoints?: Map<SessionId, Checkpoint>): Promise<void> {
    const adapter = this.#adapters.get(platform);
    if (!adapter) throw new Error(`no adapter registered for platform "${platform}"`);

    const contextFiles = await Promise.all(
      this.#config.context.map(async (path) => ({ path, body: await readFile(path, 'utf8') })),
    );

    const roleInstructionCache = new Map<RoleName, string>();
    const roleInstructions = async (role: RoleName): Promise<string> => {
      const cached = roleInstructionCache.get(role);
      if (cached !== undefined) return cached;
      const body = await readFile(this.#config.roles[role], 'utf8');
      roleInstructionCache.set(role, body);
      return body;
    };

    await this.#launchOne(adapter, platform, 'root', 'root', contextFiles, await roleInstructions('root'), checkpoints?.get('root'));

    for (const coordinator of this.#config.coordinators) {
      await this.#launchOne(
        adapter,
        platform,
        coordinator.id,
        'coordinator',
        contextFiles,
        await roleInstructions('coordinator'),
        checkpoints?.get(coordinator.id),
      );
    }
  }

  /**
   * Where a session actually runs.
   *
   * CAPO creates a git worktree per task and records it in state, but every
   * session was launched with `cwd` set to the shared workspace, so the
   * worktrees were never used. A live run made that concrete: two coordinators
   * both edited the same checkout while their worktrees sat untouched with the
   * original code. Isolation, write scopes and integration all rest on each
   * coordinator working in its own tree, so none of them were real.
   *
   * The root stays in the workspace: it integrates, so it needs to see
   * everything.
   *
   * A coordinator owning exactly one task gets that task's worktree. Owning
   * several is genuinely ambiguous under the current per-task worktree model,
   * so it stays in the workspace and says so, rather than silently picking one.
   */
  #cwdFor(role: RoleName, sessionId: SessionId): string {
    if (role !== 'coordinator') return this.#config.workspace;

    const owned = Object.values(this.#state.get().tasks).filter(
      (t) => t.coordinator === sessionId,
    );
    const only = owned.length === 1 ? owned[0] : undefined;
    if (only?.worktree !== undefined) return only.worktree;

    if (owned.length > 1) {
      this.#log(
        `[${sessionId}] owns ${owned.length} tasks, so it runs in the shared workspace ` +
          `rather than an isolated worktree. Give each coordinator one task for isolation.`,
      );
    }
    return this.#config.workspace;
  }

  async #launchOne(
    adapter: PlatformAdapter,
    platform: PlatformId,
    sessionId: SessionId,
    role: RoleName,
    contextFiles: { path: string; body: string }[],
    roleInstructions: string,
    checkpoint: Checkpoint | undefined,
  ): Promise<void> {
    const model = this.#config.models[role][platform];
    if (model === undefined) {
      throw new Error(`no model configured for role "${role}" on platform "${platform}"`);
    }

    const systemPrompt = buildSystemPrompt({
      config: this.#config,
      role,
      sessionId,
      contextFiles,
      roleInstructions,
      checkpoint,
    });

    const opts: StartSessionOptions = {
      sessionId,
      role,
      model,
      cwd: this.#cwdFor(role, sessionId),
      systemPrompt,
      prompt: checkpoint ? 'Resume your work from your checkpoint, above.' : 'Begin work toward the objective, above.',
      autonomy: this.#config.autonomy,
    };

    if (this.#config.transcripts) {
      // A header per launch, so a transcript that spans a platform switch
      // makes it obvious where the session moved and which model took over.
      void appendTranscript(
        this.#runDir,
        sessionId,
        renderSessionHeader(sessionId, platform, model, checkpoint !== undefined),
      );
    }

    const session = await adapter.start(opts);
    this.#live.set(sessionId, { session, role, platform });
    // A fresh clock for the stall watchdog: a relaunch on the other platform
    // after a switch reuses the same session id, and must not inherit a
    // "stalled" mark (or its last-event time) from the platform it just left.
    this.#lastEventAt.set(sessionId, Date.now());
    this.#stalledSet.delete(sessionId);

    await this.#update((draft) => {
      draft.sessions[sessionId] = {
        id: sessionId,
        role,
        platform,
        platformSessionId: session.platformSessionId,
        status: 'starting',
      };
    });

    void this.#pump(sessionId, platform, session);
  }

  async #pump(sessionId: SessionId, platform: PlatformId, session: AdapterSession): Promise<void> {
    try {
      for await (const event of session.events()) {
        await this.#onEvent(sessionId, platform, event);
      }
    } catch (err) {
      this.#log(`[${sessionId}] pump error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #onEvent(sessionId: SessionId, platform: PlatformId, event: AdapterEvent): Promise<void> {
    // Mirror everything to the session's transcript first, so a reader sees
    // the work as it happens even for events CAPO itself ignores. This never
    // throws and never blocks the state machine below.
    if (this.#config.transcripts) {
      const line = renderEvent(event);
      if (line !== undefined) void appendTranscript(this.#runDir, sessionId, line);
    }

    // Any event at all is proof of life, so it resets the stall clock
    // regardless of what kind it is. Only the (rare) transition out of
    // "stalled" is written to state and the transcript — see `#checkStalls`
    // for why every event isn't.
    this.#lastEventAt.set(sessionId, Date.now());
    if (this.#stalledSet.delete(sessionId)) {
      await this.#update((draft) => {
        const record = draft.sessions[sessionId];
        if (record) {
          record.stalled = false;
          delete record.stalledSince;
        }
      });
      if (this.#config.transcripts) {
        void appendTranscript(this.#runDir, sessionId, renderStallClearedNotice());
      }
    }

    switch (event.kind) {
      case 'ready': {
        await this.#update((draft) => {
          const record = draft.sessions[sessionId];
          if (record) {
            record.platformSessionId = event.platformSessionId;
            record.status = 'running';
          }
        });
        break;
      }

      case 'text': {
        this.#log(`[${sessionId}] ${event.text}`);
        const resolver = this.#pending.get(sessionId);
        if (resolver) {
          const block = extractCheckpoint(event.text);
          if (block !== undefined) {
            resolver(parseCheckpoint(block));
          }
        }
        break;
      }

      case 'tool': {
        this.#log(`[${sessionId}] tool: ${event.name}${event.detail ? ` (${event.detail})` : ''}`);
        break;
      }

      case 'usage-limit': {
        await this.#update((draft) => {
          draft.limits[platform] = {
            detectedAt: new Date().toISOString(),
            resetAt: event.resetAt,
            raw: event.raw,
          };
        });
        void this.requestSwitch(undefined, 'usage-limit');
        break;
      }

      case 'turn-end': {
        break;
      }

      case 'error': {
        this.#log(`[${sessionId}] error: ${event.message}`);
        if (!event.retryable) {
          await this.#update((draft) => {
            const record = draft.sessions[sessionId];
            if (record) record.status = 'failed';
          });
        }
        break;
      }

      case 'exit': {
        this.#log(`[${sessionId}] exit: ${event.code ?? 'null'}`);
        break;
      }
    }
  }
}
