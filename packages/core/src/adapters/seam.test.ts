import { describe, expect, it } from 'vitest';
import { FakeAdapter } from './fake.js';
import { parseCheckpoint } from '../checkpoint/render.js';
import type { AdapterEvent, Checkpoint } from '../types.js';

/**
 * Task 6 built FakeAdapter before the checkpoint renderer existed, so it
 * formats checkpoint Markdown by hand. That duplication is only safe while the
 * real parser can still read what the fake writes. This test pins that seam:
 * if either side's format drifts, the orchestrator's switch tests would start
 * passing against a checkpoint the product could never actually parse.
 */
describe('fake adapter checkpoint output parses with the real parser', () => {
  const cp: Checkpoint = {
    sessionId: 'team-a', runId: '2026-09-12-001', role: 'coordinator',
    platform: 'claude', written: '2026-09-12T14:20:05.000Z', baseCommit: '3f2a9c1',
    objective: 'Build component A with tests.',
    decisions: ['Used the existing http client'],
    done: ['src/a/client.ts written, 4 tests pass'],
    inProgress: ['Retry backoff: jitter test fails'],
    remaining: ['Fix jitter test', 'Document the retry policy'],
    blockers: [],
  };

  it('round-trips through parseCheckpoint back to the armed checkpoint', async () => {
    const a = new FakeAdapter('claude');
    const s = await a.start({
      sessionId: 'team-a', role: 'coordinator', model: 'sonnet',
      cwd: process.cwd(), systemPrompt: '', prompt: 'go',
    });
    a.replyWithCheckpoint('team-a', cp);

    const seen: AdapterEvent[] = [];
    const pump = (async () => { for await (const e of s.events()) seen.push(e); })();
    await s.send('please checkpoint');
    await new Promise((r) => setTimeout(r, 20));
    await s.close();
    await pump;

    const text = seen.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('\n');
    const fence = text.match(/```(?:markdown)?\n([\s\S]*?)```/);
    expect(fence, 'fake emitted a fenced block').not.toBeNull();

    const parsed = parseCheckpoint(fence![1]!);
    expect(parsed).toEqual(cp);
  });
});
