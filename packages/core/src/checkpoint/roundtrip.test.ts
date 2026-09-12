import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCheckpoint, parseCheckpoint } from './render.js';
import { writeCheckpointSet, readCheckpointSet, latestCheckpointSet } from './store.js';
import type { Checkpoint } from '../types.js';

const cp = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  sessionId: 'team-a', runId: '2026-09-12-001', role: 'coordinator', platform: 'claude',
  written: '2026-09-12T14:20:05.000Z', baseCommit: '3f2a9c1',
  objective: 'Build component A with tests.',
  decisions: ['Used the existing http client', 'Kept the public API unchanged'],
  done: ['src/a/client.ts written, 4 tests pass (commit 9ab1)'],
  inProgress: ['Retry backoff: written but the jitter test fails'],
  remaining: ['Fix jitter test', 'Document the retry policy'],
  blockers: [],
  ...over,
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'capo-cp-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('checkpoint round-trip', () => {
  it('renders the documented headings in order', () => {
    const md = renderCheckpoint(cp());
    expect(md.split('\n')[0]).toBe('# Checkpoint: team-a');
    expect(md).toContain('run: 2026-09-12-001');
    expect(md).toContain('base_commit: 3f2a9c1');
    const order = ['## Objective', '## Decisions made', '## Done',
                   '## In progress', '## Remaining', '## Blockers and open questions'];
    let at = -1;
    for (const h of order) {
      const i = md.indexOf(h);
      expect(i, `${h} present`).toBeGreaterThan(at);
      at = i;
    }
  });

  it('parses back to an equal object', () => {
    expect(parseCheckpoint(renderCheckpoint(cp()))).toEqual(cp());
  });

  it('survives an empty section', () => {
    const c = cp({ blockers: [], decisions: [] });
    expect(parseCheckpoint(renderCheckpoint(c)).decisions).toEqual([]);
  });

  it('survives multi-line and markdown-bearing bullets', () => {
    const c = cp({ remaining: ['Fix `parse()` so it handles a `## heading` inside a bullet'] });
    expect(parseCheckpoint(renderCheckpoint(c)).remaining).toEqual(c.remaining);
  });

  it('round-trips the root task table', () => {
    const c = cp({ role: 'root', sessionId: 'root', taskTable: [
      { id: 'a', coordinator: 'team-a', briefPath: '/x/a.md',
        writeScope: ['src/a/'], state: 'running' },
    ]});
    expect(parseCheckpoint(renderCheckpoint(c)).taskTable).toEqual(c.taskTable);
  });

  it('rejects a file with no checkpoint heading', () => {
    expect(() => parseCheckpoint('just some notes')).toThrow(/not a checkpoint/i);
  });
});

describe('checkpoint sets', () => {
  it('writes a numbered set with an index and reads it back', async () => {
    const set = { index: 1, reason: 'usage-limit' as const, platform: 'claude',
                  written: '2026-09-12T14:20:05.000Z',
                  checkpoints: [cp(), cp({ sessionId: 'root', role: 'root' })] };
    const out = await writeCheckpointSet(dir, set);
    expect(out).toBe(join(dir, 'checkpoints', '001'));
    expect(await readFile(join(out, 'INDEX.md'), 'utf8')).toContain('usage-limit');
    const back = await readCheckpointSet(dir, 1);
    expect(back.checkpoints.map(c => c.sessionId).sort()).toEqual(['root', 'team-a']);
    expect(back.reason).toBe('usage-limit');
  });

  it('latestCheckpointSet picks the highest index, not lexical order', async () => {
    for (const index of [1, 2, 10]) {
      await writeCheckpointSet(dir, { index, reason: 'user-switch', platform: 'claude',
        written: new Date().toISOString(), checkpoints: [cp()] });
    }
    expect((await latestCheckpointSet(dir))!.index).toBe(10);
  });

  it('latestCheckpointSet returns undefined when there are none', async () => {
    expect(await latestCheckpointSet(dir)).toBeUndefined();
  });

  it('never overwrites an existing set', async () => {
    const set = { index: 1, reason: 'stop' as const, platform: 'claude',
                  written: new Date().toISOString(), checkpoints: [cp()] };
    await writeCheckpointSet(dir, set);
    await expect(writeCheckpointSet(dir, set)).rejects.toThrow(/already exists/i);
  });
});
