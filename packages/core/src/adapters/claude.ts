/**
 * The Claude Code platform adapter: drives the real `claude` CLI in
 * stream-json mode.
 *
 * Verified surface (Claude Code 2.1.236, confirmed against the real CLI on
 * 2026-09-13 — see `__fixtures__/claude-real-stream.jsonl` and
 * `__fixtures__/claude-real-toolcall.jsonl` for the captures):
 *   claude -p --output-format stream-json --input-format stream-json
 *          --verbose --session-id <uuid> --model <model>
 *          --append-system-prompt <text> --permission-mode <see permissionMode>
 *
 * Newline-delimited JSON in on stdin, newline-delimited JSON events out on
 * stdout. `readJsonLines` (the one piece of code this adapter shares with
 * the Codex adapter) turns the byte stream into parsed lines; everything
 * about what those lines *mean* is Claude-specific and lives here.
 *
 * What the live run confirmed and what it corrected, in order of surprise:
 *
 *  - `system`/`init` (carrying `session_id`) is NOT sent once per process.
 *    It is sent again before EVERY turn (i.e. before the assistant's
 *    response to every `send()`, not just the first prompt). The original
 *    code re-pushed a `ready` event and re-resolved the (already-resolved)
 *    ready promise on every one of these — harmless for the promise, but it
 *    put a spurious `ready` event on the queue mid-stream, which the
 *    conformance contract ("ready` is the very first event") never
 *    exercised because it only starts one session per test. Fixed by only
 *    honoring the first `system`/`init` seen; later ones are dropped.
 *  - There is no dedicated stream event carrying the literal phrase "usage
 *    limit reached" in `-p` mode. What actually exists is a top-level
 *    `rate_limit_event` with a structured `rate_limit_info: { status:
 *    "allowed" | "allowed_warning" | "rejected", resetsAt?: <unix seconds>,
 *    rateLimitType?: string }`. The adapter originally only pattern-matched
 *    assistant text for "usage limit reached", which a live run never once
 *    produced — every limit signal that exists is this structured event.
 *    `status: "rejected"` is now the primary source of `usage-limit` events;
 *    the text pattern match is kept as a fallback in case some future
 *    surface reports a limit only in prose. `"rejected"` itself was not
 *    observed live (this account never hit a limit); its existence and
 *    field shape come from the CLI's own embedded schema (extracted via
 *    `strings` on the installed binary — see the report), not from a
 *    triggered live event, so treat this mapping as evidence-based but not
 *    end-to-end verified.
 *  - A `result` line can carry `is_error: true` for a turn that failed
 *    (bad input, a refused request, an API error) without ever emitting
 *    assistant text describing it. The original code treated every `result`
 *    as a plain `turn-end`, silently swallowing that failure. A failed
 *    result is now also surfaced as a non-retryable `error` event ahead of
 *    the `turn-end`, mirroring how the Codex adapter surfaces `turn.failed`.
 *    This path is informed by the CLI's own schema (`is_error`/
 *    `api_error_status` fields) rather than a captured failing run: no live
 *    run in this investigation actually failed a turn.
 *  - Everything else checked out: `ready` fires correctly off `session_id`;
 *    `--append-system-prompt` text is genuinely honored (confirmed by
 *    asking the model to repeat a codeword that only appeared there);
 *    `send()`/a second turn on the same process works; assistant `text` and
 *    `tool_use` blocks match the assumed shape exactly, including that each
 *    content block arrives as its own `assistant` line rather than batched;
 *    and no approval channel is needed in `-p` mode — nothing hangs waiting
 *    for one, unlike the Codex CLI's approval stall.
 *
 *    One claim that used to sit here was wrong, and a later full run caught
 *    it: `--permission-mode acceptEdits` does NOT auto-approve Bash. It
 *    approved the `Write` this probe tried and the read-only commands, and
 *    the conclusion was over-generalised from that. See `permissionMode`.
 *  - A live run showed sessions picking up this machine's user-scope
 *    plugins, skills and hooks: the root loaded CAPO's own `capo:capo`
 *    skill and ran `capo status` on its own run, and coordinators loaded
 *    unrelated skills like `superpowers:systematic-debugging`, with ~37k
 *    tokens of that system prompt repeated on every turn. `start()` now
 *    passes `--setting-sources project,local` to drop user-scope settings
 *    while still honoring a project's own configuration.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
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

/** How long to wait for a session to report itself ready before giving up. */
const READY_TIMEOUT_MS = 120_000;

const USAGE_LIMIT_RE = /usage limit reached/i;
/**
 * Pulls a reset time out of a usage-limit message as an ISO timestamp.
 *
 * Returns undefined rather than a human string like "3pm (UTC)": `resetAt` is
 * contractually an ISO timestamp that the orchestrator compares against now,
 * and an unparseable value there would make a capped platform look available.
 * The original wording survives in the event's `raw`.
 */
function extractResetAt(text: string): string | undefined {
  return parseResetAt(text);
}

/**
 * Converts a `rate_limit_info.resetsAt` value (Unix seconds, per the CLI's
 * own schema) to an ISO timestamp. Unlike `extractResetAt` this is not
 * parsing human prose — it is a number straight off the wire — so it never
 * goes through `parseResetAt`'s regex matching.
 */
function resetsAtToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const d = new Date(value * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * "…usage limit reached|1757800000": the CLI's historical -p result text
 * carries the reset as unix seconds after a pipe.
 */
function epochSuffixToIso(text: string): string | undefined {
  const m = /\|(\d{9,11})\b/.exec(text);
  return m ? resetsAtToIso(Number(m[1])) : undefined;
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

  if (obj.type === 'rate_limit_event') {
    const info = obj.rate_limit_info as Record<string, unknown> | undefined;
    const status = info?.status;
    // "allowed" and "allowed_warning" are informational (the account is
    // fine, or approaching a limit but not yet blocked); only "rejected"
    // means this turn was actually refused for being over the limit.
    if (status !== 'rejected') return [];

    const rateLimitType = typeof info?.rateLimitType === 'string' ? info.rateLimitType : 'unknown';
    const resetAt = resetsAtToIso(info?.resetsAt);
    const raw = `claude-code rate limit rejected (${rateLimitType})${
      resetAt !== undefined ? ` resets at ${resetAt}` : ''
    }`;
    return [resetAt !== undefined ? { kind: 'usage-limit', raw, resetAt } : { kind: 'usage-limit', raw }];
  }

  if (obj.type === 'result') {
    const events: AdapterEvent[] = [];
    const text = typeof obj.result === 'string' ? obj.result : '';
    if (obj.is_error === true && USAGE_LIMIT_RE.test(text)) {
      // The CLI's historical -p usage-limit phrasing can also arrive on an
      // is_error result line rather than as assistant text or a structured
      // rate_limit_event (see the header note on `rate_limit_event` above).
      const resetAt = epochSuffixToIso(text) ?? extractResetAt(text);
      events.push(resetAt !== undefined ? { kind: 'usage-limit', raw: text, resetAt } : { kind: 'usage-limit', raw: text });
    } else if (obj.is_error === true) {
      events.push({
        kind: 'error',
        message: text.length > 0 ? text : 'claude-code: turn ended with an error',
        retryable: false,
      });
    }
    events.push({ kind: 'turn-end' });
    return events;
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
      permissionMode(opts.autonomy),
      // User-scope settings are where installed plugins, their skills and
      // hooks live. A live run showed the root loading CAPO's own plugin skill
      // and driving `capo status` against its own run, and coordinators
      // loading unrelated skills; each turn also carried ~37k tokens of that
      // system prompt. Project and local settings still apply, so a project's
      // own configuration is honored.
      '--setting-sources',
      'project,local',
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
            // A live run showed `system`/`init` is re-sent before every
            // turn, not just once at process start (see the header note).
            // Only the first one means anything: honoring later ones would
            // put a second `ready` event on the queue mid-stream, which
            // nothing downstream expects.
            if (platformSessionId === undefined) {
              platformSessionId = event.platformSessionId;
              queue.push(event);
              resolveReady?.();
            }
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

    // The prompt goes FIRST, before waiting for ready. Claude Code does not
    // emit `system`/`init` until it has received a first user message: with
    // stdin open and nothing sent, it emits only SessionStart hook events and
    // then waits. Awaiting ready before writing deadlocks both sides forever,
    // the adapter waiting for init and the CLI waiting for input.
    //
    // Found by a full orchestration run against the real CLI. No stub test
    // could catch it, because a stub emits init whether or not anyone speaks
    // first. The stub now mirrors the real ordering.
    if (!exited) {
      child.stdin.write(userMessageLine(opts.prompt));
    }

    // Bound the wait. An adapter that hangs forever is strictly worse than one
    // that fails: a hung session looks identical to a working one from the
    // outside, and that is exactly how this bug survived until a real run.
    await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(
            new CapoError(
              `claude-code: session "${opts.sessionId}" produced no init event within ${READY_TIMEOUT_MS / 1000}s`,
              'Check `claude doctor` and that the CLI is logged in. A SessionStart hook that never finishes can also block startup.',
            ),
          );
        }, READY_TIMEOUT_MS);
        timer.unref();
      }),
    ]);

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

/**
 * Maps CAPO's autonomy level onto a Claude Code permission mode.
 *
 * A headless session has nobody to ask, so the choice is really between
 * "allowed to act" and "dry run".
 *
 * `acceptEdits` was used here until a full run proved it insufficient, and
 * the comment this replaces claimed a live run had confirmed it auto-approves
 * Bash. It does not. It accepts file edits and denies every mutating Bash
 * call with "This command requires approval"; the earlier probe had only run
 * read-only commands, which do go through. The consequence was total: a
 * coordinator could write the fix but could not run the tests or
 * `git commit`, so it could never produce the result commit the entire
 * result protocol is built on. Both coordinators in that run reported the
 * same blocker and the run could not finish.
 *
 * So autonomous maps to a full grant, and that is worth stating plainly
 * rather than burying: the session may run any command. What makes it
 * defensible is where it runs. Every coordinator is confined to its own git
 * worktree, and `autonomy: autonomous` is the setting whose whole meaning is
 * "act without asking". A user who does not want that has `supervised`,
 * which maps to `plan`: read and reason, write nothing.
 *
 * Defaults to autonomous when unset, matching the config default.
 */
function permissionMode(level: AutonomyLevel | undefined): string {
  return (level ?? 'autonomous') === 'supervised' ? 'plan' : 'bypassPermissions';
}
