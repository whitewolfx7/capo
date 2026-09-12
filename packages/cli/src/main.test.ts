import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, runDir } from '@capo/core';
import type { RunState } from '@capo/core';
import { main } from './main.js';
import type { Io } from './io.js';

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

const baseState = (runId: string): RunState => ({
  version: 1,
  runId,
  activePlatform: 'claude',
  status: 'running',
  pauseCount: 0,
  baseCommit: 'deadbeef',
  sessions: {
    root: { id: 'root', role: 'root', platform: 'claude', status: 'running' },
  },
  tasks: {
    't1': {
      id: 't1',
      coordinator: 'c1',
      briefPath: '/tmp/brief.md',
      writeScope: ['src/'],
      state: 'ready',
    },
  },
  limits: {},
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe('capo CLI', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'capo-cli-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('--help exits 0 and names all five commands', async () => {
    const { io, out } = capture();
    const code = await main(['--help'], io);
    expect(code).toBe(0);
    const text = out.join('\n');
    for (const cmd of ['run', 'status', 'switch', 'resume', 'doctor']) {
      expect(text).toContain(cmd);
    }
  });

  it('an unknown command exits 2 and names it', async () => {
    const { io, err } = capture();
    const code = await main(['bogus-command'], io);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('bogus-command');
  });

  it('run with a bad config exits 1 and prints the CapoError hint', async () => {
    const { io, err } = capture();
    const badConfig = join(dir, 'nope.yaml');
    const code = await main(['run', '--config', badConfig], io);
    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toContain(badConfig);
    // loadConfig's CapoError always carries a hint; it must be printed too.
    expect(err.length).toBeGreaterThanOrEqual(2);
  });

  it('status --json on a scaffolded run directory prints parseable JSON with activePlatform and the task table', async () => {
    const workspace = dir;
    const runId = '2026-09-12-001';
    const rdir = runDir(workspace, runId);
    await StateStore.create(rdir, baseState(runId));

    const { io, out } = capture();
    const code = await main(['status', runId, '--json', '--workspace', workspace], io);
    expect(code).toBe(0);

    const doc = JSON.parse(out.join('\n'));
    expect(doc.activePlatform).toBe('claude');
    expect(Array.isArray(doc.taskTable)).toBe(true);
    expect(doc.taskTable[0].id).toBe('t1');
  });

  it('status on a nonexistent run exits 1 saying no run found', async () => {
    const { io, err } = capture();
    const code = await main(['status', 'nonexistent-run', '--workspace', dir], io);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no run found');
  });

  it('doctor --json returns a document with node, git, and one entry per platform', async () => {
    const { io, out } = capture();
    const code = await main(['doctor', '--json'], io);
    // On this machine every tool is present, so this just checks shape.
    expect([0, 1]).toContain(code);
    const doc = JSON.parse(out.join('\n'));
    expect(doc.node).toBeDefined();
    expect(doc.git).toBeDefined();
    expect(doc.platforms['claude-code']).toBeDefined();
    expect(doc.platforms['codex']).toBeDefined();
  });

  it('doctor --json exits 1 when a required tool is missing', async () => {
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const emptyBinDir = await mkdtemp(join(tmpdir(), 'capo-empty-bin-'));
    const scratchWorkspace = await mkdtemp(join(tmpdir(), 'capo-doctor-ws-'));

    process.chdir(scratchWorkspace);
    process.env.PATH = emptyBinDir;
    try {
      const { io, out } = capture();
      const code = await main(['doctor', '--json'], io);
      expect(code).toBe(1);
      const doc = JSON.parse(out.join('\n'));
      expect(doc.ok).toBe(false);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
      await rm(emptyBinDir, { recursive: true, force: true });
      await rm(scratchWorkspace, { recursive: true, force: true });
    }
  });
});
