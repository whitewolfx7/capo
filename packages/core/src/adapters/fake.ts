/**
 * A scriptable in-memory `PlatformAdapter` used by every test in the project
 * that does not want to spawn a real CLI. It is also the reference
 * implementation of the adapter contract: `conformance.ts` describes the
 * contract, this file is proof it is satisfiable.
 */
import { randomUUID } from 'node:crypto';
import type {
  AdapterEvent,
  AdapterSession,
  Checkpoint,
  DoctorResult,
  PlatformAdapter,
  PlatformId,
  SessionId,
  StartSessionOptions,
} from '../types.js';

/**
 * When a `StartSessionOptions.prompt` contains this string, the fake (and,
 * per the plan, each real adapter's stub executable) emits a `usage-limit`
 * event without needing a real account to actually be capped.
 */
export const EMIT_LIMIT_SENTINEL = '__EMIT_LIMIT__';

export interface FakeScript {
  /** Events queued immediately after the automatic `ready` event on start(). */
  onStart?: AdapterEvent[];
  /** Called on every send(); its return value is queued as that turn's reply. */
  onSend?: (text: string, turn: number) => AdapterEvent[];
  /** Overrides the default `{ ok: true, problems: [] }` doctor() result. */
  doctor?: DoctorResult;
}

/**
 * A promise-based FIFO queue backing one session's event stream. `push()`
 * either resolves a pending consumer immediately or buffers the event;
 * `end()` flushes any pending consumer with a done result and makes every
 * later `next()` resolve done immediately. Never polls.
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

interface FakeSessionState {
  readonly queue: EventQueue;
  closed: boolean;
  turn: number;
  armedCheckpoint?: Checkpoint;
}

/**
 * Render a Checkpoint as the fenced Markdown block a real session's reply to
 * `CHECKPOINT_REQUEST` is expected to be: a fence whose body's first line is
 * `# Checkpoint: <sessionId>`, in the same header-then-`##`-sections shape
 * `checkpoint/parse.ts` parses. Kept self-contained (no import from
 * `checkpoint/render.ts`) so this file has no dependency on Task 4's output.
 */
function renderCheckpointBlock(cp: Checkpoint): string {
  const list = (items: string[]): string =>
    items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '_none_';

  const body = [
    `# Checkpoint: ${cp.sessionId}`,
    `run: ${cp.runId}`,
    `role: ${cp.role}`,
    `platform: ${cp.platform}`,
    `written: ${cp.written}`,
    `base_commit: ${cp.baseCommit}`,
    '',
    '## Objective',
    cp.objective,
    '',
    '## Decisions made',
    list(cp.decisions),
    '',
    '## Done',
    list(cp.done),
    '',
    '## In progress',
    list(cp.inProgress),
    '',
    '## Remaining',
    list(cp.remaining),
    '',
    '## Blockers and open questions',
    list(cp.blockers),
  ].join('\n');

  return '```markdown\n' + body + '\n```';
}

export class FakeAdapter implements PlatformAdapter {
  readonly id: PlatformId;
  readonly started: StartSessionOptions[] = [];
  readonly sent: { sessionId: SessionId; text: string }[] = [];
  readonly closed: SessionId[] = [];

  private readonly script: FakeScript | undefined;
  private readonly sessions = new Map<SessionId, FakeSessionState>();
  private nextStartError: string | undefined;

  constructor(id: PlatformId, script?: FakeScript) {
    this.id = id;
    this.script = script;
  }

  async doctor(): Promise<DoctorResult> {
    return this.script?.doctor ?? { ok: true, problems: [] };
  }

  async start(opts: StartSessionOptions): Promise<AdapterSession> {
    this.started.push(opts);

    if (this.nextStartError !== undefined) {
      const message = this.nextStartError;
      this.nextStartError = undefined;
      throw new Error(message);
    }

    const state: FakeSessionState = { queue: new EventQueue(), closed: false, turn: 0 };
    this.sessions.set(opts.sessionId, state);

    const platformSessionId = `fake-${this.id}-${opts.sessionId}-${randomUUID()}`;
    state.queue.push({ kind: 'ready', platformSessionId });

    for (const event of this.script?.onStart ?? []) {
      state.queue.push(event);
    }

    if (opts.prompt.includes(EMIT_LIMIT_SENTINEL)) {
      state.queue.push({ kind: 'usage-limit', raw: `fake adapter saw ${EMIT_LIMIT_SENTINEL} in the prompt` });
    }

    const adapter = this;
    const sessionId = opts.sessionId;

    const session: AdapterSession = {
      sessionId,
      platformSessionId,

      async send(text: string): Promise<void> {
        const current = adapter.sessions.get(sessionId);
        if (!current || current.closed) {
          throw new Error(`fake adapter: cannot send to session "${sessionId}": session is closed`);
        }

        adapter.sent.push({ sessionId, text });

        if (current.armedCheckpoint) {
          const cp = current.armedCheckpoint;
          current.armedCheckpoint = undefined;
          current.queue.push({ kind: 'text', text: renderCheckpointBlock(cp) });
          current.queue.push({ kind: 'turn-end' });
          current.turn += 1;
          return;
        }

        if (adapter.script?.onSend) {
          const events = adapter.script.onSend(text, current.turn);
          for (const event of events) current.queue.push(event);
        }
        current.turn += 1;
      },

      events(): AsyncIterable<AdapterEvent> {
        return state.queue;
      },

      async interrupt(): Promise<void> {
        // The fake owns no real process; nothing to signal.
      },

      async close(): Promise<void> {
        const current = adapter.sessions.get(sessionId);
        if (!current || current.closed) return;
        current.closed = true;
        current.queue.end();
        adapter.closed.push(sessionId);
      },
    };

    return session;
  }

  /** Push an event into a live session's stream from a test body. */
  emit(sessionId: SessionId, event: AdapterEvent): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) {
      throw new Error(`fake adapter: cannot emit to session "${sessionId}": not started or already closed`);
    }
    state.queue.push(event);
  }

  /**
   * End a live session's event stream without the orchestrator having asked,
   * the way a real session ends when its CLI process dies on its own. Unlike
   * `close()`, this is not recorded in `closed`: nothing closed it, it just
   * stopped.
   */
  endStream(sessionId: SessionId): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) {
      throw new Error(`fake adapter: cannot end session "${sessionId}": not started or already closed`);
    }
    state.closed = true;
    state.queue.end();
  }

  /** Make exactly the next start() call reject with `message`, and only the next one. */
  failNextStart(message: string): void {
    this.nextStartError = message;
  }

  /**
   * Arm `sessionId` so that its next reply (the events pushed by its next
   * send() call) is a fenced checkpoint block for `cp`, instead of whatever
   * the script's onSend would otherwise produce.
   */
  replyWithCheckpoint(sessionId: SessionId, cp: Checkpoint): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) {
      throw new Error(
        `fake adapter: cannot arm a checkpoint reply for session "${sessionId}": not started or already closed`,
      );
    }
    state.armedCheckpoint = cp;
  }
}

/** Convenience constructor for a usage-limit event in test bodies. */
export function emitLimit(resetAt?: string): AdapterEvent {
  if (resetAt !== undefined) {
    return { kind: 'usage-limit', resetAt, raw: 'fake adapter: usage limit reached' };
  }
  return { kind: 'usage-limit', raw: 'fake adapter: usage limit reached' };
}
