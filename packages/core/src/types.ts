/**
 * The shared contract for CAPO v0.1.
 *
 * Every other module in the project depends on these names. They are defined
 * once, here, and are not redefined, widened, or aliased elsewhere. If a change
 * is needed, change it here and update the plan.
 */

export type PlatformId = string;
export type RoleName = 'root' | 'coordinator' | 'worker';
export type SessionId = string;
export type TaskId = string;
export type RunId = string;

/* ---------- config ---------- */

export interface ConfigTask {
  id: TaskId;
  coordinator: SessionId;
  /** Absolute path to the task brief. */
  brief: string;
  /** Workspace-relative POSIX paths. A trailing slash means a directory. */
  writeScope: string[];
}

export interface CapoConfig {
  version: 1;
  /** Absolute path of the config file this was loaded from. */
  configPath: string;
  /** Absolute path of the project the run operates on. */
  workspace: string;
  /** Absolute path to the objective Markdown file. */
  objective: string;
  platforms: Record<PlatformId, { driver: string }>;
  startOn: PlatformId;
  /** role -> platform -> model name, as that platform's CLI accepts it. */
  models: Record<RoleName, Record<PlatformId, string>>;
  /** Absolute paths to role instruction files. */
  roles: Record<RoleName, string>;
  /** Absolute paths to shared context files. */
  context: string[];
  coordinators: { id: SessionId }[];
  tasks: ConfigTask[];
  limits: { maxWorkersPerCoordinator: number };
  /**
   * Write a live, human-readable transcript per session under the run's
   * `transcripts/` directory. On by default: CAPO's sessions are headless and
   * invisible to the host, so without this there is no way to watch the work.
   * Set `transcripts: false` to turn it off.
   */
  transcripts: boolean;
  /**
   * How long a live session may emit no events at all before the orchestrator
   * marks it "stalled" (see `SessionRecord.stalled`). A session that finished
   * its work and a session stuck waiting forever for a permission answer that
   * will never come look identical from the outside: both go quiet. This is
   * the threshold that turns that silence into something visible. Purely
   * informational — crossing it never kills or switches anything.
   */
  stallTimeoutMs: number;
  /**
   * How much autonomy a session gets to act without stopping to ask a human,
   * applied per platform adapter (an adapter that has no use for the
   * distinction may ignore it). "supervised" is the default and changes
   * nothing about a platform's own out-of-the-box behavior. "autonomous"
   * currently only affects the Codex adapter: see its `autonomyFlags` for why
   * granting it is defensible here.
   */
  autonomy: AutonomyLevel;
  /**
   * The combined check run once, over the fully integrated tree, after every
   * task's result has merged -- e.g. `["npm", "test"]`. Passed to `execFile`
   * as argv, never a shell string. CAPO cannot guess how a project verifies
   * itself, so there is no sensible non-empty default: an empty array (the
   * default) means integration accepts a clean merge on its own, with no
   * combined check to run.
   */
  checkCommand: string[];
}

export type AutonomyLevel = 'supervised' | 'autonomous';

/* ---------- run state ---------- */

export type TaskState =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'review'
  | 'done'
  | 'failed';

export interface TaskRecord {
  id: TaskId;
  coordinator: SessionId;
  briefPath: string;
  writeScope: string[];
  state: TaskState;
  /** Absolute path of this task's git worktree, once created. */
  worktree?: string;
  branch?: string;
  baseCommit?: string;
  resultCommit?: string;
  /** The test-evidence narrative from the coordinator's result submission. */
  evidence?: string;
  note?: string;
}

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'failed';

export interface SessionRecord {
  id: SessionId;
  role: RoleName;
  platform: PlatformId;
  /** Opaque to CAPO. Whatever the platform calls its own session. */
  platformSessionId?: string;
  status: SessionStatus;
  /**
   * Set once the session has gone `stallTimeoutMs` with no events at all.
   * Optional (rather than defaulted `false`) so older `state.json` files, and
   * anything that builds a `SessionRecord` by hand, stay valid without it.
   * Never implies failure: a session can be working hard and silent, e.g.
   * mid a long tool call.
   */
  stalled?: boolean;
  /** ISO timestamp of when `stalled` most recently became true. */
  stalledSince?: string;
}

export type RunStatus = 'running' | 'switching' | 'waiting' | 'done' | 'failed';

export interface LimitRecord {
  detectedAt: string;
  /** ISO timestamp, when the platform told us one. */
  resetAt?: string;
  raw: string;
}

export interface RunState {
  version: 1;
  runId: RunId;
  activePlatform: PlatformId;
  status: RunStatus;
  /** Number of pauses so far. Also the highest checkpoint set index. */
  pauseCount: number;
  baseCommit: string;
  sessions: Record<SessionId, SessionRecord>;
  tasks: Record<TaskId, TaskRecord>;
  limits: Record<PlatformId, LimitRecord>;
  startedAt: string;
  updatedAt: string;
}

/* ---------- checkpoints ---------- */

export type PauseReason = 'usage-limit' | 'user-switch' | 'both-capped' | 'stop';

/**
 * What one session carries across a platform switch. This is a product
 * surface: it is written as Markdown a person can read, edit, and paste into
 * a chat window by hand.
 */
export interface Checkpoint {
  sessionId: SessionId;
  runId: RunId;
  role: RoleName;
  platform: PlatformId;
  written: string;
  baseCommit: string;
  objective: string;
  decisions: string[];
  done: string[];
  inProgress: string[];
  remaining: string[];
  blockers: string[];
  /** Root sessions only: the task table at the moment of the pause. */
  taskTable?: TaskRecord[];
}

export interface CheckpointSet {
  index: number;
  reason: PauseReason;
  /** The platform the sessions were running on when they checkpointed. */
  platform: PlatformId;
  written: string;
  checkpoints: Checkpoint[];
}

/* ---------- adapter contract ---------- */

export interface StartSessionOptions {
  sessionId: SessionId;
  role: RoleName;
  model: string;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  /**
   * Optional so adapters (and every existing call site, real or in tests)
   * that predate this field keep compiling and default to the conservative
   * "supervised" behavior. Only the Codex adapter currently reads it.
   */
  autonomy?: AutonomyLevel;
}

export type AdapterEvent =
  | { kind: 'ready'; platformSessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'usage-limit'; resetAt?: string; raw: string }
  | { kind: 'turn-end' }
  | { kind: 'error'; message: string; retryable: boolean }
  | { kind: 'exit'; code: number | null };

export interface AdapterSession {
  readonly sessionId: SessionId;
  readonly platformSessionId: string | undefined;
  send(text: string): Promise<void>;
  events(): AsyncIterable<AdapterEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface DoctorResult {
  ok: boolean;
  version?: string;
  problems: string[];
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  doctor(): Promise<DoctorResult>;
  start(opts: StartSessionOptions): Promise<AdapterSession>;
}

/* ---------- errors ---------- */

/** An error a user caused and can fix. `hint` says how. */
export class CapoError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CapoError';
    this.hint = hint;
  }
}
