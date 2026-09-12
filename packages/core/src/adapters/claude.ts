/**
 * The Claude Code platform adapter: drives the real `claude` CLI in
 * stream-json mode.
 *
 * Verified surface (Claude Code 2.1.236):
 *   claude -p --output-format stream-json --input-format stream-json
 *          --verbose --session-id <uuid> --model <model>
 *          --append-system-prompt <text> --permission-mode acceptEdits
 *
 * Newline-delimited JSON in on stdin, newline-delimited JSON events out on
 * stdout. `readJsonLines` (the one piece of code this adapter shares with
 * the Codex adapter) turns the byte stream into parsed lines; everything
 * about what those lines *mean* is Claude-specific and lives here.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readJsonLines } from './lines.js';
import type {
  AdapterEvent,
  AdapterSession,
  DoctorResult,
  PlatformAdapter,
  PlatformId,
  SessionId,
  StartSessionOptions,
} from '../types.js';

export interface ClaudeAdapterOptions {
  /** Defaults to `claude`. Overridden in tests to point at the stub. */
  executable?: string;
  /** Prepended to the built argv. Tests use this to inject the stub's own path. */
  extraArgs?: string[];
}

/**
 * A promise-based FIFO queue backing one session's event stream. Mirrors the
 * shape of `FakeAdapter`'s internal queue (see `fake.ts`) but is not shared
 * code: `push()` after `end()` is a no-op, `end()` flushes any pending
 * consumer, and nothing here ever polls.
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

const USAGE_LIMIT_RE = /usage limit reached/i;
const RESET_AT_RE = /reset at ([^.]+?)\.?\s*$/i;

/** Pulls a human-readable reset time out of a usage-limit message, if present. */
function extractResetAt(text: string): string | undefined {
  const match = RESET_AT_RE.exec(text);
  return match?.[1]?.trim();
}

/**
 * Maps one parsed stdout line to zero or more adapter events. A line that
 * parses as JSON but doesn't match a known Claude Code message shape (an
 * unhandled `system` subtype, a stray banner) is dropped rather than
 * surfaced: the conformance contract requires `ready` to be the very first
 * event a fresh session's `events()` ever yields, so nothing may be queued
 * ahead of it. A line that fails to parse as JSON at all is handled by the
 * caller, not here (see the `readJsonLines` consumer in `start()`), and
 * still becomes a `text` event so stdout noise never crashes a session.
 */
function mapLine(value: unknown): AdapterEvent[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  const obj = value as Record<string, unknown>;

  if (obj.type === 'system' && obj.subtype === 'init') {
    const sessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined;
    if (!sessionId) return [];
    return [{ kind: 'ready', platformSessionId: sessionId }];
  }

  if (obj.type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    const events: AdapterEvent[] = [];

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'text' && typeof b.text === 'string') {
        if (USAGE_LIMIT_RE.test(b.text)) {
          const resetAt = extractResetAt(b.text);
          events.push(
            resetAt !== undefined
              ? { kind: 'usage-limit', raw: b.text, resetAt }
              : { kind: 'usage-limit', raw: b.text },
          );
        } else {
          events.push({ kind: 'text', text: b.text });
        }
        continue;
      }

      if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : 'unknown-tool';
        const detail = b.input !== undefined ? JSON.stringify(b.input) : undefined;
        events.push(detail !== undefined ? { kind: 'tool', name, detail } : { kind: 'tool', name });
        continue;
      }
    }

    return events;
  }

  if (obj.type === 'result') {
    return [{ kind: 'turn-end' }];
  }

  // A recognized-but-unhandled envelope (other system subtypes, etc.): not
  // an error, just not mapped to anything.
  return [];
}

function userMessageLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

const execFileAsync = promisify(execFile);

export class ClaudeAdapter implements PlatformAdapter {
  readonly id: PlatformId = 'claude-code';

  /**
   * Not part of `PlatformAdapter`. The test stub's very first stdout line is
   * its own argv, echoed as a JSON array so a test can assert the exact
   * command line without a second channel to the child process. A JSON
   * array is never a real Claude Code stream-json message, so capturing it
   * here (instead of feeding it through `mapLine`) is safe for the real CLI
   * too: `lastArgv` simply stays `undefined` against a real `claude`, which
   * never emits one.
   */
  lastArgv: string[] | undefined;

  private readonly executable: string;
  private readonly extraArgs: string[];

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.executable = opts.executable ?? 'claude';
    this.extraArgs = opts.extraArgs ?? [];
  }

  /**
   * Reports whether this platform can actually be driven.
   *
   * `capo doctor` exists so a user finds out the CLI is missing BEFORE
   * starting a run and watching it die mysteriously, so reporting ok
   * unconditionally would defeat the command. `--version` is a verified,
   * side-effect-free surface on Claude Code 2.1.236 and needs no account.
   *
   * This deliberately does NOT probe login state. There is no documented
   * offline way to ask, and a network round trip does not belong in a
   * preflight check. An unauthenticated CLI surfaces as an `error` or `exit`
   * event once a session starts.
   */
  async doctor(): Promise<DoctorResult> {
    try {
      const { stdout } = await execFileAsync(
        this.executable,
        [...this.extraArgs, '--version'],
        { timeout: 10_000 },
      );
      const version = stdout.trim().split('\n')[0]?.trim();
      return version
        ? { ok: true, version, problems: [] }
        : { ok: false, problems: [`\`${this.executable} --version\` printed nothing`] };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        problems: [
          `could not run \`${this.executable} --version\`: ${detail}`,
        ],
      };
    }
  }

  async start(opts: StartSessionOptions): Promise<AdapterSession> {
    const uuid = randomUUID();
    const args = [
      ...this.extraArgs,
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--session-id',
      uuid,
      '--model',
      opts.model,
      '--append-system-prompt',
      opts.systemPrompt,
      '--permission-mode',
      'acceptEdits',
    ];

    const child: ChildProcessWithoutNullStreams = spawn(this.executable, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const queue = new EventQueue();
    const sessionId: SessionId = opts.sessionId;

    let closed = false;
    let exited = false;
    let exitCode: number | null = null;
    let platformSessionId: string | undefined;

    let resolveReady: (() => void) | undefined;
    let rejectReady: ((err: Error) => void) | undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code) => {
        exited = true;
        exitCode = code;
        queue.push({ kind: 'exit', code });
        resolve();
        rejectReady?.(new Error(`claude-code: process exited (code ${String(code)}) before session became ready`));
      });
    });

    child.once('error', (err) => {
      queue.push({ kind: 'error', message: err.message, retryable: false });
      rejectReady?.(err);
    });

    (async () => {
      for await (const line of readJsonLines(child.stdout)) {
        if (!line.ok) {
          queue.push({ kind: 'text', text: line.raw });
          continue;
        }
        if (Array.isArray(line.value)) {
          // See `lastArgv` above: the stub's argv echo, not a protocol line.
          this.lastArgv = line.value as string[];
          continue;
        }
        for (const event of mapLine(line.value)) {
          if (event.kind === 'ready') {
            platformSessionId = event.platformSessionId;
            queue.push(event);
            resolveReady?.();
          } else {
            queue.push(event);
          }
        }
      }
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      queue.push({ kind: 'error', message, retryable: false });
    });

    child.stdin.on('error', () => {
      // Writing to a stdin whose process has already exited throws
      // asynchronously on the stream too; the write()'s own callback/promise
      // rejection (see send() below) is what callers observe.
    });

    await readyPromise;

    // The initial prompt is just the first turn: deliver it exactly like
    // send() would once the session is up and running.
    if (!exited) {
      child.stdin.write(userMessageLine(opts.prompt));
    }

    const session: AdapterSession = {
      sessionId,
      get platformSessionId(): string | undefined {
        return platformSessionId;
      },

      async send(text: string): Promise<void> {
        if (closed || exited) {
          throw new Error(`claude-code: cannot send to session "${sessionId}": session is closed`);
        }
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(userMessageLine(text), (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },

      events(): AsyncIterable<AdapterEvent> {
        return queue;
      },

      async interrupt(): Promise<void> {
        if (exited) return;
        child.kill('SIGINT');
      },

      async close(): Promise<void> {
        if (closed) return;
        closed = true;

        try {
          child.stdin.end();
        } catch {
          // Already gone; nothing to end.
        }

        if (!exited) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (!exited) {
                try {
                  child.kill('SIGKILL');
                } catch {
                  // Already gone.
                }
              }
            }, 5000);
            exitPromise.then(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }

        queue.end();
      },
    };

    return session;
  }
}
