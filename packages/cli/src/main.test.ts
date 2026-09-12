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

describe('capo status liveness', () => {
  let dir: string;

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'capo-live-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /**
   * state.json records what a run was doing, not whether anyone is still
   * doing it. A crashed orchestrator leaves a file that still says "running"
   * with every session "running". Reporting that as healthy is worse than
   * saying nothing, because the user's next move depends on knowing to
   * resume.
   */
  async function seed(runId: string, pid?: number): Promise<void> {
    const runPath = runDir(dir, runId);
    await StateStore.create(runPath, baseState(runId));
    if (pid !== undefined) {
      await writeFile(join(runPath, 'orchestrator.pid'), String(pid));
    }
  }

  it('warns and names the resume command when the orchestrator is gone', async () => {
    // PID 2^22 is above the default pid_max on Linux and macOS, so it is a
    // pid that reliably does not exist.
    await seed('2026-09-12-001', 4_194_304);
    const { io, out } = capture();
    expect(await main(['status', '2026-09-12-001', '--workspace', dir], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/no live orchestrator process/i);
    expect(text).toContain('capo resume 2026-09-12-001');
  });

  it('warns when there is no pid file at all', async () => {
    await seed('2026-09-12-002');
    const { io, out } = capture();
    expect(await main(['status', '2026-09-12-002', '--workspace', dir], io)).toBe(0);
    expect(out.join('\n')).toMatch(/no live orchestrator process/i);
  });

  it('reports live false in JSON so a script can tell', async () => {
    await seed('2026-09-12-003', 4_194_304);
    const { io, out } = capture();
    expect(await main(['status', '2026-09-12-003', '--json', '--workspace', dir], io)).toBe(0);
    const doc = JSON.parse(out.join('\n')) as { live: boolean; status: string };
    expect(doc.live).toBe(false);
    expect(doc.status).toBe('running');
  });

  it('reports live true when the process really is running', async () => {
    await seed('2026-09-12-004', process.pid);
    const { io, out } = capture();
    expect(await main(['status', '2026-09-12-004', '--json', '--workspace', dir], io)).toBe(0);
    expect((JSON.parse(out.join('\n')) as { live: boolean }).live).toBe(true);
    const human = capture();
    await main(['status', '2026-09-12-004', '--workspace', dir], human.io);
    expect(human.out.join('\n')).not.toMatch(/no live orchestrator/i);
  });
});
