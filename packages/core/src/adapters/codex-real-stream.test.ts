import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from './codex.js';
import type { AdapterEvent } from '../types.js';

const replay = fileURLToPath(new URL('./__fixtures__/codex-replay.mjs', import.meta.url));
const stream = fileURLToPath(new URL('./__fixtures__/codex-real-stream.jsonl', import.meta.url));

/**
 * These assertions run against a REAL capture of `codex exec --json`
 * (codex-cli 0.147.0, 2026-09-12), not against shapes we invented.
 *
 * This file exists because the adapter's original mapping was guessed, and
 * every guess was wrong. It expected `session_configured`, `agent_message`
 * and `task_complete`; the real stream has `thread.started`, `turn.started`,
 * `item.completed`, `turn.failed`. The symptom was not a missing feature but
 * a hang: no `ready` event means `start()` never resolves and a run never
 * begins.
 */
describe('CodexAdapter against a real captured stream', () => {
  async function drain(): Promise<AdapterEvent[]> {
    const adapter = new CodexAdapter({
      executable: process.execPath,
      extraArgs: [replay, stream],
    });
    const session = await adapter.start({
      sessionId: 'team-a', role: 'coordinator', model: 'gpt-5-codex',
      cwd: process.cwd(), systemPrompt: '', prompt: 'go',
    });
    const seen: AdapterEvent[] = [];
    const pump = (async () => { for await (const e of session.events()) seen.push(e); })();
    await new Promise((r) => setTimeout(r, 150));
    await session.close();
    await pump;
    return seen;
  }

  it('becomes ready from thread.started, carrying the real thread id', async () => {
    const events = await drain();
    const ready = events.find((e) => e.kind === 'ready');
    expect(ready, 'a ready event, or start() would hang forever').toBeDefined();
    if (ready?.kind === 'ready') {
      // The thread_id in the capture.
      expect(ready.platformSessionId).toBe('01a096ac-dcc9-7711-8c69-e718b56404c5');
    }
  });

  it('treats codex warning items as retryable, not as a dead session', async () => {
    // The real stream carries two error-typed items before the turn even
    // starts: a clamped hook timeout and a model metadata miss. Both are
    // warnings. Killing a session over them would make CAPO unusable on a
    // machine that simply has plugins installed.
    const events = await drain();
    const warnings = events.filter((e) => e.kind === 'error' && e.retryable);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((e) => e.kind === 'error' && /hook timeout/i.test(e.message))).toBe(true);
  });

  it('reports a failed turn as an error followed by a turn boundary', async () => {
    const events = await drain();
    const idx = events.findIndex((e) => e.kind === 'error' && !e.retryable);
    expect(idx, 'the turn failure').toBeGreaterThanOrEqual(0);
    expect(events.slice(idx).some((e) => e.kind === 'turn-end')).toBe(true);
  });

  it('surfaces the underlying API message so a user can act on it', async () => {
    const events = await drain();
    const fatal = events.find((e) => e.kind === 'error' && !e.retryable);
    // The capture failed because the account's model needs a newer CLI. That
    // is exactly the kind of thing a user must be told verbatim.
    expect(fatal?.kind === 'error' && fatal.message).toMatch(/requires a newer version of Codex/i);
  });

  it('never emits a usage-limit for this stream', async () => {
    const events = await drain();
    expect(events.some((e) => e.kind === 'usage-limit')).toBe(false);
  });
});
