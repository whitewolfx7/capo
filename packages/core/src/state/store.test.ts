import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, readState, allocateRunId, runDir } from './store.js';
import type { RunState } from '../types.js';

let dir: string;
const base = (): RunState => ({
  version: 1, runId: 'r1', activePlatform: 'claude', status: 'running',
  pauseCount: 0, baseCommit: 'abc', sessions: {}, tasks: {}, limits: {},
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'capo-state-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('StateStore', () => {
  it('creates, persists and reopens', async () => {
    const s = await StateStore.create(dir, base());
    await s.update(d => { d.activePlatform = 'codex'; });
    const reopened = await StateStore.open(dir);
    expect(reopened.get().activePlatform).toBe('codex');
  });

  it('get() returns a clone that cannot mutate stored state', async () => {
    const s = await StateStore.create(dir, base());
    s.get().activePlatform = 'mutated';
    expect(s.get().activePlatform).toBe('claude');
  });

  it('bumps updatedAt on every update', async () => {
    const s = await StateStore.create(dir, base());
    const before = s.get().updatedAt;
    await new Promise(r => setTimeout(r, 5));
    await s.update(d => { d.status = 'waiting'; });
    expect(s.get().updatedAt > before).toBe(true);
  });

  it('serializes concurrent updates without losing any', async () => {
    const s = await StateStore.create(dir, base());
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        s.update(d => { d.tasks[`t${i}`] = {
          id: `t${i}`, coordinator: 'c', briefPath: 'b', writeScope: [], state: 'pending' }; })),
    );
    expect(Object.keys(s.get().tasks)).toHaveLength(50);
    expect(Object.keys((await readState(dir)).tasks)).toHaveLength(50);
  });

  it('leaves no temp files behind', async () => {
    const s = await StateStore.create(dir, base());
    await s.update(d => { d.status = 'done'; });
    const files = await readdir(dir);
    expect(files.filter(f => f.includes('.tmp'))).toHaveLength(0);
  });

  it('writes readable indented JSON', async () => {
    await StateStore.create(dir, base());
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toContain('\n  "runId"');
  });

  it('open() on a missing directory throws a CapoError with a hint', async () => {
    await expect(StateStore.open(join(dir, 'nope'))).rejects.toThrow(/no run found/i);
  });

  it('flush() resolves after every queued update has been written and leaves no tmp files', async () => {
    const store = await StateStore.create(dir, base());
    void store.update((d) => { d.pauseCount = 1; });
    void store.update((d) => { d.pauseCount = 2; });
    await store.flush();
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).pauseCount).toBe(2);
  });
});

describe('allocateRunId', () => {
  it('starts at 001 and increments per day', async () => {
    const now = new Date('2026-09-12T10:00:00Z');
    const a = await allocateRunId(dir, now);
    expect(a).toBe('2026-09-12-001');
    await StateStore.create(runDir(dir, a), { ...base(), runId: a });
    expect(await allocateRunId(dir, now)).toBe('2026-09-12-002');
  });
});
