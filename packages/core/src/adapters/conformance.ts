/**
 * The shared adapter conformance suite.
 *
 * This is a source file, not a `*.test.ts` file, so that `claude.test.ts` and
 * `codex.test.ts` can import `runAdapterConformance` and register it against
 * their own adapters. It defines what "being a platform adapter" means for
 * CAPO: every adapter, fake or real, must satisfy every assertion here.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, AdapterSession, PlatformAdapter, StartSessionOptions } from '../types.js';

/** A minimal, valid set of start options every adapter must accept. */
export function opts0(): StartSessionOptions {
  return {
    sessionId: 'root',
    role: 'root',
    model: 'test-model',
    cwd: process.cwd(),
    systemPrompt: 'be a helpful test session',
    prompt: 'go',
  };
}

/** Read the first event off a session's stream. */
export async function firstEvent(session: AdapterSession): Promise<AdapterEvent> {
  const iterator = session.events()[Symbol.asyncIterator]();
  const result = await iterator.next();
  if (result.done || result.value === undefined) {
    throw new Error('events() ended before yielding a single event');
  }
  return result.value;
}

/** Drain a session's stream until an event of the given kind arrives. */
export async function eventOfKind(
  session: AdapterSession,
  kind: AdapterEvent['kind'],
): Promise<AdapterEvent> {
  for await (const event of session.events()) {
    if (event.kind === kind) return event;
  }
  throw new Error(`events() ended without ever producing a "${kind}" event`);
}

/**
 * Register a `describe` block asserting the adapter contract every
 * `PlatformAdapter` implementation must satisfy. `make()` must return a
 * fresh adapter instance suitable for exactly the tests in one `it()` block
 * (conformance tests do not share adapter instances across cases).
 */
export function runAdapterConformance(
  name: string,
  make: () => Promise<PlatformAdapter>,
  opts: { skipLimit?: boolean } = {},
): void {
  describe(`adapter conformance: ${name}`, () => {
    it('reports an id', async () => expect((await make()).id).toBeTruthy());

    it('doctor() resolves with an ok flag and a problems array', async () => {
      const d = await (await make()).doctor();
      expect(typeof d.ok).toBe('boolean');
      expect(Array.isArray(d.problems)).toBe(true);
    });

    it('emits ready with a platform session id before any other event', async () => {
      const s = await (await make()).start(opts0());
      const first = await firstEvent(s);
      expect(first.kind).toBe('ready');
      expect(s.platformSessionId).toBeTruthy();
      await s.close();
    });

    it('events() terminates after close()', async () => {
      const s = await (await make()).start(opts0());
      const seen: AdapterEvent[] = [];
      const pump = (async () => {
        for await (const e of s.events()) seen.push(e);
      })();
      await s.close();
      await expect(pump).resolves.toBeUndefined();
    });

    it('close() is idempotent', async () => {
      const s = await (await make()).start(opts0());
      await s.close();
      await s.close();
    });

    it('send() after close() rejects rather than hanging', async () => {
      const s = await (await make()).start(opts0());
      await s.close();
      await expect(s.send('hi')).rejects.toThrow();
    });

    if (!opts.skipLimit) {
      it('surfaces a usage limit as a usage-limit event, not an error', async () => {
        const s = await (await make()).start({ ...opts0(), prompt: '__EMIT_LIMIT__' });
        const e = await eventOfKind(s, 'usage-limit');
        expect(e.kind).toBe('usage-limit');
        await s.close();
      });

      /**
       * `resetAt` is contractually an ISO timestamp, and the orchestrator
       * decides whether a platform is still capped by comparing it to now. A
       * human string like "3pm (UTC)" parses to an Invalid Date, every
       * comparison against it is false, and a capped platform looks available
       * again: CAPO switches back into it, gets limited, and flaps. An adapter
       * that cannot produce a real timestamp must omit the field, which the
       * orchestrator reads as "capped until told otherwise" and waits.
       */
      it('reports resetAt as a usable timestamp, or not at all', async () => {
        const s = await (await make()).start({ ...opts0(), prompt: '__EMIT_LIMIT__' });
        const e = await eventOfKind(s, 'usage-limit');
        if (e.kind === 'usage-limit' && e.resetAt !== undefined) {
          expect(
            Number.isNaN(new Date(e.resetAt).getTime()),
            `resetAt ${JSON.stringify(e.resetAt)} must parse as a date`,
          ).toBe(false);
        }
        await s.close();
      });
    }
  });
}
