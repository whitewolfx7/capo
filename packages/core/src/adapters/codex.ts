/**
 * The Codex platform adapter: drives the real `codex` CLI in `exec` mode.
 *
 * `codex exec` runs exactly one turn per process: the process is invoked
 * with a prompt, it streams JSON events on stdout, and it exits once the
 * turn is done. There is no persistent process to talk to for a second
 * message the way the Claude Code adapter has one long-lived stream-json
 * process. So a single `AdapterSession` here owns a SEQUENCE of child
 * processes — one per turn — chained so that each later `send()` spawns
 * `codex exec resume <sessionId>` only after the previous turn's process has
 * fully finished, while presenting ONE continuous `events()` stream to the
 * caller for the whole session. A child exiting normally at the end of its
 * turn produces a `turn-end` event, never an `exit` event: `exit` is
 * reserved for a child that dies before completing its turn cleanly. Only
 * `close()` ends the session's stream.
 *
 * `app-server` mode (a persistent JSON-RPC process, `codex app-server`) is
 * out of scope for v0.1; `start()` throws for it. When it is implemented,
 * its types should come from `codex app-server generate-ts`, not be
 * hand-written.
 *
 * Autonomy (verified against `codex exec --help`, codex-cli 0.154.0): with no
 * extra flags, `codex exec` still routes some approval requests through
 * whatever policy the user's own `~/.codex/config.toml` sets, and a headless
 * run has nobody there to answer them. A real coordinator hit exactly this:
 * it correctly diagnosed a one-line fix, ended its turn asking "approve?",
 * and then sat there forever, because in `exec` mode there is no channel for
 * a "yes" to arrive on. See `autonomyFlags` for the fix and why it is safe to
 * offer here specifically.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readJsonLines } from './lines.js';
import { parseResetAt } from './reset-time.js';
import { CapoError } from '../types.js';
import type {
  AdapterEvent,
  AdapterSession,
  AutonomyLevel,
  DoctorResult,
  PlatformAdapter,
  PlatformId,
  SessionId,
  StartSessionOptions,
} from '../types.js';

type CodexMode = 'exec' | 'app-server';

export interface CodexAdapterOptions {
  executable?: string;
  extraArgs?: string[];
  mode?: CodexMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Codex-shaped event lines look like `{"id": "...", "msg": {"type": ...}}`.
 * Tolerate a flat `{"type": ...}` shape too, in case a given CLI version
 * emits one.
 */
function extractMsg(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.msg)) return value.msg;
  if (typeof value.type === 'string') return value;
  return undefined;
}

/**
 * A promise-based FIFO queue backing one session's event stream, shared by
 * every child process that session spawns over its lifetime. `push()`
 * either resolves a pending consumer immediately or buffers the event;
 * `end()` flushes any pending consumer with a done result and makes every
 * later `next()` resolve done immediately. Never polls.
 *
 * Deliberately not imported from `fake.ts`: adapters are meant to diverge,
 * and this is the only piece of that file's shape this one happens to need.
 */
class EventQueue implements AsyncIterable<AdapterEvent> {
  private readonly buffer: AdapterEvent[] = [];
  private readonly waiting: Array<(result: IteratorResult<AdapterEvent>) => void> = [];
  private ended = false;

  push(event: AdapterEvent): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    let waiter = this.waiting.shift();
    while (waiter) {
      waiter({ value: undefined, done: true });
      waiter = this.waiting.shift();
    }
  }

  private next(): Promise<IteratorResult<AdapterEvent>> {
    const value = this.buffer.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
    return { next: () => this.next() };
  }
}

function execCapture(
  executable: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Maps `CapoConfig.autonomy` onto the `codex exec` flags that give it effect.
 * `undefined` (an adapter constructed against an older `StartSessionOptions`,
 * or a caller that never set it) is treated the same as "supervised".
 *
 * "supervised" adds nothing: whatever `codex exec` and the user's own
 * `~/.codex/config.toml` would otherwise do, unchanged. This is the config
 * default (`autonomy: 'supervised'` in `orchestration.yaml`), deliberately:
 * CAPO does not widen what a session can do on a real repository unless the
 * person running it asks for that.
 *
 * "autonomous" adds `--approve-for-me`, which (per `codex exec --help`)
 * "route[s] approval requests through automatic review using the
 * workspace-write sandbox" instead of blocking on an interactive answer that,
 * in a headless `exec` process, can never come. This is NOT
 * `--dangerously-bypass-approvals-and-sandbox`: the session still runs inside
 * the workspace-write sandbox, its approval requests are reviewed rather than
 * rubber-stamped, and it is still just one Codex CLI flag away from a human
 * being asked, not zero. It is defensible as a config *choice* (never
 * hardcoded on) specifically in CAPO because of what already surrounds it:
 * every task runs in its own git worktree (`git/repo.ts#addWorktree`),
 * confined to a write scope declared in `orchestration.yaml`, and
 * `integrate/merge.ts#acceptResult` independently re-checks a submitted diff
 * against that scope before anything reaches the real branch — so a session
 * that never has to stop and ask can still only ever touch its own corner of
 * the repository, and even that is checked again on the way out.
 */
function autonomyFlags(level: AutonomyLevel | undefined): string[] {
  switch (level ?? 'supervised') {
    case 'autonomous':
      return ['--approve-for-me'];
    case 'supervised':
      return [];
  }
}

class CodexAdapterSession implements AdapterSession {
  readonly sessionId: SessionId;
  platformSessionId: string | undefined;

  /**
   * Every child's echoed argv line, in spawn order. Test-only introspection
   * — not part of the `AdapterSession` contract — so codex.test.ts can
   * assert on the exact command lines without spawning the real CLI or
   * surfacing this as a fake "event" that would break the conformance
   * suite's "ready is always first" rule.
   */
  readonly debugArgv: string[][] = [];

  private readonly executable: string;
  private readonly extraArgs: string[];
  private readonly cwd: string;
  private readonly queue = new EventQueue();
  private closed = false;
  private currentChild: ChildProcess | undefined;
  /** Chains turns so a later send() never spawns its child until the
   * previous turn's child has fully finished. */
  private turnChain: Promise<void> = Promise.resolve();
  /**
   * Set once, from `begin()`'s `opts.autonomy`, and reused by every later
   * `send()`: a session's autonomy doesn't change mid-run, and `send()` never
   * sees a fresh `StartSessionOptions` to read it from again.
   */
  private autonomyArgs: string[] = [];

  constructor(executable: string, extraArgs: string[], sessionId: SessionId, cwd: string) {
    this.executable = executable;
    this.extraArgs = extraArgs;
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  /** Spawns the first turn and resolves once its session-configured event
   * has arrived and `platformSessionId` is set — not once the turn ends. */
  begin(opts: StartSessionOptions): Promise<void> {
    this.autonomyArgs = autonomyFlags(opts.autonomy);

    // `codex exec` has no --append-system-prompt: its PROMPT argument is
    // documented as "initial instructions for the agent" and is the only
    // input channel. So the system prompt is prepended to the first turn.
    //
    // This is not cosmetic. The system prompt carries the objective, the role
    // instructions, the session's write scope, and the checkpoint protocol.
    // An earlier version passed only `opts.prompt`, and a live run showed
    // real Codex sessions replying "no concrete objective appears in the
    // visible request" — and, worse, with no knowledge of the checkpoint
    // protocol they could never have survived a platform switch.
    //
    // The autonomy flags (if any) land right after `exec`: `codex exec`
    // parses `-s`/`--approve-for-me` at that level whether or not a `resume`
    // subcommand follows (verified with `codex exec --approve-for-me resume
    // --help`), so the same placement works unchanged in send() below too.
    const args = ['exec', ...this.autonomyArgs, '--json', '-m', opts.model, composeFirstTurn(opts)];
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const run = this.enqueueTurn(args, onReady);
      run.catch((err: unknown) => {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async send(text: string): Promise<void> {
    if (this.closed) {
      throw new Error(`codex adapter: cannot send to session "${this.sessionId}": session is closed`);
    }
    if (!this.platformSessionId) {
      throw new Error(
        `codex adapter: cannot send to session "${this.sessionId}": no platform session id yet`,
      );
    }
    const args = ['exec', ...this.autonomyArgs, 'resume', this.platformSessionId, '--json', text];

    let resolveSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const run = this.enqueueTurn(args, undefined, resolveSpawned);
    // Failures surface to the caller as 'error'/'exit' events on the shared
    // stream, not as a send() rejection — send() only promises the next
    // child was spawned, matching how the Claude adapter's send() only
    // promises the message was written to stdin.
    run.catch(() => {});

    await spawned;
  }

  events(): AsyncIterable<AdapterEvent> {
    return this.queue;
  }

  async interrupt(): Promise<void> {
    if (this.currentChild && this.currentChild.exitCode === null && !this.currentChild.killed) {
      this.currentChild.kill('SIGINT');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.currentChild;
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
    this.queue.end();
  }

  private enqueueTurn(args: string[], onReady?: () => void, onSpawned?: () => void): Promise<void> {
    const run = this.turnChain.then(() => this.runTurn(args, onReady, onSpawned));
    // Keep the chain alive even if a turn errors internally; runTurn itself
    // never rejects (failures are reported as queue events), but guard
    // anyway so one bad turn can't wedge every later send().
    this.turnChain = run.catch(() => {});
    return run;
  }

  private async runTurn(args: string[], onReady?: () => void, onSpawned?: () => void): Promise<void> {
    if (this.closed) {
      onSpawned?.();
      return;
    }

    const child = spawn(this.executable, [...this.extraArgs, ...args], {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentChild = child;
    onSpawned?.();

    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    let spawnError: Error | undefined;
    child.on('error', (err) => {
      spawnError = err;
    });

    let turnSettled = false;

    if (child.stdout) {
      try {
        for await (const line of readJsonLines(child.stdout)) {
          if (this.closed) break;
          if (!line.ok) continue; // noise on stdout must not kill the turn

          const value = line.value;
          if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
            // The stub's argv-echo line (real `codex` never emits this):
            // test-only introspection, not a session event.
            this.debugArgv.push(value);
            continue;
          }

          for (const event of this.mapEvent(value, onReady)) {
            if (event.kind === 'turn-end' || event.kind === 'usage-limit') turnSettled = true;
            this.queue.push(event);
          }
        }
      } catch (err) {
        this.queue.push({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        });
      }
    }

    const code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.once('exit', (exitCode) => resolve(exitCode));
      child.once('error', () => resolve(null));
    });

    this.currentChild = undefined;

    if (this.closed) return;

    if (spawnError) {
      this.queue.push({ kind: 'error', message: spawnError.message, retryable: false });
      this.queue.push({ kind: 'exit', code });
      return;
    }

    if (!turnSettled) {
      // The child died (or exited) without ever producing a turn-end or a
      // usage-limit event: a genuine abnormal termination, not a normal
      // turn boundary. This is the one case that gets an 'exit' event.
      const message = stderrBuf.trim() || `codex exited with code ${code ?? 'null'} before completing the turn`;
      this.queue.push({ kind: 'error', message, retryable: false });
      this.queue.push({ kind: 'exit', code });
    }
  }

  /**
   * Maps one line of `codex exec --json` onto CAPO's adapter events.
   *
   * The schema here is taken from a REAL capture of codex-cli 0.147.0, kept
   * at `__fixtures__/codex-real-stream.jsonl`. An earlier version of this
   * mapper guessed at `session_configured` / `agent_message` /
   * `task_complete`, none of which exist. The consequence was not a missing
   * feature but a hang: without a `ready` event, `start()` never resolves and
   * a run never begins.
   *
   * The real envelope is:
   *   {"type":"thread.started","thread_id":"..."}
   *   {"type":"turn.started"}
   *   {"type":"item.completed","item":{"id":"...","type":"...", ...}}
   *   {"type":"turn.completed"} | {"type":"turn.failed","error":{"message":"..."}}
   *   {"type":"error","message":"..."}
   *
   * `item.type` values beyond "error" are still inferred: a successful turn
   * has not been captured, so assistant text and tool calls are matched
   * permissively rather than pinned to exact names.
   */
  private mapEvent(value: unknown, onReady?: () => void): AdapterEvent[] {
    const record = extractMsg(value);
    if (!record) return [];
    const type = typeof record.type === 'string' ? record.type : undefined;

    switch (type) {
      // The session id. Without this the session never becomes ready.
      case 'thread.started': {
        const sid =
          typeof record.thread_id === 'string'
            ? record.thread_id
            : typeof record.session_id === 'string'
              ? record.session_id
              : undefined;
        if (sid && !this.platformSessionId) {
          this.platformSessionId = sid;
          onReady?.();
          return [{ kind: 'ready', platformSessionId: sid }];
        }
        return [];
      }

      case 'turn.started':
        return [];

      case 'item.completed':
        return this.mapItem(record.item);

      case 'turn.completed':
        return [{ kind: 'turn-end' }];

      case 'turn.failed': {
        const message = errorMessageOf(record.error) ?? 'codex turn failed';
        if (isUsageLimit(message)) return [usageLimitEvent(message)];
        // A failed turn is still a finished turn: the session stays alive and
        // the next send() starts a new one.
        return [
          { kind: 'error', message, retryable: false },
          { kind: 'turn-end' },
        ];
      }

      case 'error': {
        const message = typeof record.message === 'string' ? record.message : 'codex error';
        if (isUsageLimit(message)) return [usageLimitEvent(message)];
        return [{ kind: 'error', message, retryable: false }];
      }

      default:
        return [];
    }
  }

  /** One `item.completed` payload. Item types other than "error" are inferred. */
  private mapItem(item: unknown): AdapterEvent[] {
    if (typeof item !== 'object' || item === null) return [];
    const rec = item as Record<string, unknown>;
    const itemType = typeof rec.type === 'string' ? rec.type : '';
    const message = typeof rec.message === 'string' ? rec.message : undefined;
    const text = typeof rec.text === 'string' ? rec.text : undefined;

    if (itemType === 'error') {
      const body = message ?? 'codex reported an error';
      if (isUsageLimit(body)) return [usageLimitEvent(body)];
      // Codex emits warnings as error items (a hook timeout being clamped, a
      // model metadata miss). Those are not failures and must not be treated
      // as such, so they surface as retryable rather than killing a session.
      return [{ kind: 'error', message: body, retryable: true }];
    }

    // Assistant prose. Matched permissively because the exact item type for a
    // successful turn has not been captured.
    if (/message|agent|assistant|text/i.test(itemType)) {
      const body = text ?? message;
      return body === undefined ? [] : [{ kind: 'text', text: body }];
    }

    // Anything with a command or tool shape is reported as tool activity.
    if (/command|exec|tool|patch|file/i.test(itemType)) {
      const name =
        typeof rec.command === 'string'
          ? rec.command
          : typeof rec.name === 'string'
            ? rec.name
            : itemType;
      return [{ kind: 'tool', name }];
    }

    return [];
  }

}

export class CodexAdapter implements PlatformAdapter {
  readonly id: PlatformId = 'codex';

  private readonly executable: string;
  private readonly extraArgs: string[];
  private readonly mode: CodexMode;

  constructor(opts?: CodexAdapterOptions) {
    this.executable = opts?.executable ?? 'codex';
    this.extraArgs = opts?.extraArgs ?? [];
    this.mode = opts?.mode ?? 'exec';
  }

  async doctor(): Promise<DoctorResult> {
    try {
      const result = await execCapture(this.executable, [...this.extraArgs, '--version']);
      if (result.code === 0) {
        const version = result.stdout.trim();
        return { ok: true, version: version.length > 0 ? version : undefined, problems: [] };
      }
      const problem = result.stderr.trim() || result.stdout.trim() || `exited with code ${result.code ?? 'null'}`;
      return { ok: false, problems: [problem] };
    } catch (err) {
      return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
    }
  }

  async start(opts: StartSessionOptions): Promise<AdapterSession> {
    if (this.mode === 'app-server') {
      throw new CapoError('app-server mode is not implemented in v0.1');
    }

    const session = new CodexAdapterSession(this.executable, this.extraArgs, opts.sessionId, opts.cwd);
    await session.begin(opts);
    return session;
  }
}

/**
 * Coerces a platform-supplied reset time into an ISO timestamp, or nothing.
 *
 * Accepts an already-ISO value, falls back to parsing human wording out of
 * either the field or the surrounding message, and returns undefined when
 * neither is confident. Undefined is the safe answer: the orchestrator treats
 * a limit with no reset time as capped until told otherwise, so it waits
 * instead of switching back into a platform that is still limited.
 */
function normalizeResetAt(field: unknown, message: string): string | undefined {
  if (typeof field === 'string' && field.trim() !== '') {
    const direct = new Date(field);
    if (!Number.isNaN(direct.getTime())) return direct.toISOString();
    const parsed = parseResetAt(field);
    if (parsed !== undefined) return parsed;
  }
  return parseResetAt(message);
}

/** Pulls a message out of the several error shapes codex uses. */
function errorMessageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const m = (value as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}

function isUsageLimit(message: string): boolean {
  return /usage limit|rate limit|quota exceeded|too many requests/i.test(message);
}

/**
 * A usage limit event with a validated reset time, or none at all.
 *
 * `resetAt` is contractually an ISO timestamp the orchestrator compares
 * against now. A human string there parses to Invalid Date, which makes a
 * capped platform look available and flaps the run between platforms.
 */
function usageLimitEvent(raw: string): AdapterEvent {
  const resetAt = normalizeResetAt(undefined, raw);
  return resetAt !== undefined ? { kind: 'usage-limit', resetAt, raw } : { kind: 'usage-limit', raw };
}

/**
 * The single text blob that opens a Codex session: the system prompt, then
 * the first user turn, separated so a reader (and the model) can tell them
 * apart.
 */
export function composeFirstTurn(opts: StartSessionOptions): string {
  const system = opts.systemPrompt.trim();
  const first = opts.prompt.trim();
  if (system === '') return first;
  return [
    system,
    '',
    '---',
    '',
    '# Your first instruction',
    '',
    first,
  ].join('\n');
}
