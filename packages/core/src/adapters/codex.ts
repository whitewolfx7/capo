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
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readJsonLines } from './lines.js';
import { CapoError } from '../types.js';
import type {
  AdapterEvent,
  AdapterSession,
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

  constructor(executable: string, extraArgs: string[], sessionId: SessionId, cwd: string) {
    this.executable = executable;
    this.extraArgs = extraArgs;
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  /** Spawns the first turn and resolves once its session-configured event
   * has arrived and `platformSessionId` is set — not once the turn ends. */
  begin(opts: StartSessionOptions): Promise<void> {
    const args = ['exec', '--json', '-m', opts.model, opts.prompt];
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
    const args = ['exec', 'resume', this.platformSessionId, '--json', text];

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

  private mapEvent(value: unknown, onReady?: () => void): AdapterEvent[] {
    const record = extractMsg(value);
    if (!record) return [];
    const type = typeof record.type === 'string' ? record.type : undefined;

    switch (type) {
      case 'session_configured': {
        const sid = typeof record.session_id === 'string' ? record.session_id : undefined;
        if (sid && !this.platformSessionId) {
          this.platformSessionId = sid;
          onReady?.();
          return [{ kind: 'ready', platformSessionId: sid }];
        }
        return [];
      }

      case 'agent_message': {
        const text = typeof record.message === 'string' ? record.message : '';
        return [{ kind: 'text', text }];
      }

      case 'exec_command_begin':
      case 'mcp_tool_call_begin':
      case 'patch_apply_begin': {
        const name =
          typeof record.command === 'string'
            ? record.command
            : typeof record.tool === 'string'
              ? record.tool
              : type;
        return [{ kind: 'tool', name }];
      }

      case 'task_complete':
        return [{ kind: 'turn-end' }];

      case 'usage_limit_reached': {
        const raw = typeof record.message === 'string' ? record.message : 'codex usage limit reached';
        const resetAt = typeof record.reset_at === 'string' ? record.reset_at : undefined;
        return resetAt !== undefined ? [{ kind: 'usage-limit', resetAt, raw }] : [{ kind: 'usage-limit', raw }];
      }

      case 'error': {
        const message = typeof record.message === 'string' ? record.message : 'codex error';
        // codex-cli 0.147.0's exact wire shape for a hit rate limit was not
        // part of the verified CLI surface (only the exec/resume command
        // line was verified) — pattern-match on the message the same way
        // the Claude Code adapter is described to, rather than assume a
        // dedicated event type exists.
        if (/usage limit/i.test(message)) {
          return [{ kind: 'usage-limit', raw: message }];
        }
        return [{ kind: 'error', message, retryable: false }];
      }

      default:
        return [];
    }
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
