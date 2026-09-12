import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../config/load.js';
import { StateStore, runDir } from '../state/store.js';
import { latestCheckpointSet } from '../checkpoint/store.js';
import { git, commitAll } from '../git/repo.js';
import { FakeAdapter } from '../adapters/fake.js';
import type { AdapterSession, Checkpoint, StartSessionOptions } from '../types.js';
import { Orchestrator } from './run.js';

let dirs: string[] = [];

/**
 * A FakeAdapter that arms every session it starts to reply to the very next
 * send() with a checkpoint for itself. Since the orchestrator only ever
 * sends a session one thing -- CHECKPOINT_REQUEST, exactly once, right
 * before closing it -- arming immediately on start() is enough for the
 * session to answer instantly whenever the orchestrator later asks. No test
 * below arms anything by hand.
 */
class ArmedFakeAdapter extends FakeAdapter {
  override async start(opts: StartSessionOptions): Promise<AdapterSession> {
    const session = await super.start(opts);
    const cp: Checkpoint = {
      sessionId: opts.sessionId,
      runId: 'test-run',
      role: opts.role,
      platform: this.id,
      written: new Date().toISOString(),
      baseCommit: 'deadbeef',
      objective: `fake objective for ${opts.sessionId}`,
      decisions: [],
      done: [],
      inProgress: [],
      remaining: [],
      blockers: [],
    };
    this.replyWithCheckpoint(opts.sessionId, cp);
    return session;
  }
}

const CONFIG_YAML = `
version: 1
workspace: .
objective: ./context/GOAL.md
platforms:
  claude: { driver: claude-code }
  codex: { driver: codex }
start_on: claude
models:
  root: { claude: opus, codex: gpt-5-codex }
  coordinator: { claude: sonnet, codex: gpt-5-codex-mini }
  worker: { claude: haiku, codex: gpt-5-codex-mini }
roles:
  root: ./roles/root.md
  coordinator: ./roles/coordinator.md
  worker: ./roles/worker.md
context: [./context/PROJECT.md]
coordinators:
  - id: team-a
  - id: team-b
tasks:
  - id: task-a
    coordinator: team-a
    brief: ./tasks/a.md
    write_scope: [src/a/]
  - id: task-b
    coordinator: team-b
    brief: ./tasks/b.md
    write_scope: [src/b/]
limits:
  max_workers_per_coordinator: 2
`;

/** `await new Promise(r => setImmediate(r))` twice: lets pending microtasks/macrotasks drain. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/** An ISO timestamp one hour in the future. */
function future(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

/** Race an event promise against a short timeout so a bug never stalls the whole suite. */
function withDeadline<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)),
  ]);
}

async function harness(): Promise<{
  orch: Orchestrator;
  claude: FakeAdapter;
  codex: FakeAdapter;
  state: StateStore;
  /** The run directory (`latestCheckpointSet`, etc. take this, not the workspace). */
  dir: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  adapters: Map<string, FakeAdapter>;
}> {
  const workspace = await mkdtemp(join(tmpdir(), 'capo-orch-'));
  dirs.push(workspace);

  await git(workspace, ['init', '-b', 'main']);
  await writeFile(join(workspace, 'README.md'), '# demo\n');
  // Identity passed explicitly so the suite passes on a clean machine and CI.
  await commitAll(workspace, 'initial commit', { name: 't', email: 't@t' });

  await mkdir(join(workspace, 'context'), { recursive: true });
  await mkdir(join(workspace, 'roles'), { recursive: true });
  await mkdir(join(workspace, 'tasks'), { recursive: true });
  for (const f of [
    'context/GOAL.md',
    'context/PROJECT.md',
    'roles/root.md',
    'roles/coordinator.md',
    'roles/worker.md',
    'tasks/a.md',
    'tasks/b.md',
  ]) {
    await writeFile(join(workspace, f), `# ${f}\n`);
  }

  const configPath = join(workspace, 'orchestration.yaml');
  await writeFile(configPath, CONFIG_YAML);
  const config = await loadConfig(configPath);

  const claude = new ArmedFakeAdapter('claude');
  const codex = new ArmedFakeAdapter('codex');

  const runDirPath = runDir(workspace, 'test-run');
  const state = await StateStore.create(runDirPath, {
    version: 1,
    runId: 'test-run',
    activePlatform: config.startOn,
    status: 'running',
    pauseCount: 0,
    baseCommit: '',
    sessions: {},
    tasks: {},
    limits: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const adapters = new Map<string, FakeAdapter>([
    ['claude', claude],
    ['codex', codex],
  ]);

  const orch = new Orchestrator({ config, runDir: runDirPath, state, adapters, log: () => {} });

  return { orch, claude, codex, state, dir: runDirPath, config, adapters };
}

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('Orchestrator', () => {
  it('starts a root and one session per coordinator on the configured platform', async () => {
    const { orch, claude } = await harness();
    await orch.start();
    expect(claude.started.map((s) => s.sessionId).sort()).toEqual(['root', 'team-a', 'team-b']);
    expect(claude.started.find((s) => s.sessionId === 'root')!.model).toBe('opus');
    expect(claude.started.find((s) => s.sessionId === 'team-a')!.model).toBe('sonnet');
  });

  it('on a usage-limit event, checkpoints every session and relaunches all of them on the other platform', async () => {
    const { orch, claude, codex, dir } = await harness();
    await orch.start();
    claude.emit('team-a', { kind: 'usage-limit', resetAt: '2026-09-12T18:00:00Z', raw: 'limit' });
    await withDeadline(once(orch.events, 'switched'), 'switched');
    expect(codex.started.map((s) => s.sessionId).sort()).toEqual(['root', 'team-a', 'team-b']);
    const set = await latestCheckpointSet(dir);
    expect(set!.reason).toBe('usage-limit');
    expect(set!.checkpoints).toHaveLength(3);
  });

  it('uses the target platform model column after a switch', async () => {
    const { orch, claude, codex } = await harness();
    await orch.start();
    claude.emit('root', { kind: 'usage-limit', raw: 'limit' });
    await withDeadline(once(orch.events, 'switched'), 'switched');
    expect(codex.started.find((s) => s.sessionId === 'root')!.model).toBe('gpt-5-codex');
  });

  it('feeds each relaunched session its own checkpoint and nobody else’s', async () => {
    const { orch, claude, codex } = await harness();
    await orch.start();
    claude.emit('team-a', { kind: 'usage-limit', raw: 'limit' });
    await withDeadline(once(orch.events, 'switched'), 'switched');
    const teamA = codex.started.find((s) => s.sessionId === 'team-a')!;
    expect(teamA.systemPrompt).toContain('# Checkpoint: team-a');
    expect(teamA.systemPrompt).not.toContain('# Checkpoint: team-b');
  });

  it('records the limit and reset time in state', async () => {
    const { orch, claude, state } = await harness();
    await orch.start();
    claude.emit('root', { kind: 'usage-limit', resetAt: '2026-09-12T18:00:00Z', raw: 'x' });
    await withDeadline(once(orch.events, 'switched'), 'switched');
    expect(state.get().limits['claude']!.resetAt).toBe('2026-09-12T18:00:00Z');
    expect(state.get().activePlatform).toBe('codex');
  });

  it('when both platforms are capped, waits instead of thrashing', async () => {
    const { orch, claude, codex, state } = await harness();
    await orch.start();
    claude.emit('root', { kind: 'usage-limit', resetAt: future(), raw: 'x' });
    await withDeadline(once(orch.events, 'switched'), 'switched');
    codex.emit('root', { kind: 'usage-limit', resetAt: future(), raw: 'x' });
    await withDeadline(once(orch.events, 'waiting'), 'waiting');
    expect(state.get().status).toBe('waiting');
    expect(claude.started.filter((s) => s.sessionId === 'root')).toHaveLength(1);
  });

  it('a second limit during an in-flight switch does not start a second switch', async () => {
    const { orch, claude, codex } = await harness();
    await orch.start();
    claude.emit('team-a', { kind: 'usage-limit', raw: 'x' });
    claude.emit('team-b', { kind: 'usage-limit', raw: 'x' });
    await withDeadline(once(orch.events, 'switched'), 'switched');
    await settle();
    expect(codex.started.filter((s) => s.sessionId === 'root')).toHaveLength(1);
  });

  it('requestSwitch() by hand checkpoints with reason user-switch', async () => {
    const { orch, codex, dir } = await harness();
    await orch.start();
    await orch.requestSwitch('codex', 'user-switch');
    expect((await latestCheckpointSet(dir))!.reason).toBe('user-switch');
    expect(codex.started).toHaveLength(3);
  });

  it('increments pauseCount so checkpoint sets never collide', async () => {
    const { orch, claude, codex, state } = await harness();
    await orch.start();
    claude.emit('root', { kind: 'usage-limit', raw: 'x' });
    await withDeadline(once(orch.events, 'switched'), 'switched');
    await orch.requestSwitch('claude', 'user-switch');
    expect(state.get().pauseCount).toBe(2);
    expect(codex.started).toHaveLength(3);
  });

  it('stop() checkpoints every session and closes them all', async () => {
    const { orch, claude, dir, state } = await harness();
    await orch.start();
    await orch.stop('stop');
    expect((await latestCheckpointSet(dir))!.reason).toBe('stop');
    expect(Object.values(state.get().sessions).every((s) => s.status === 'stopped')).toBe(true);
    expect(claude.closed.sort()).toEqual(['root', 'team-a', 'team-b']);
  });
});

describe('Orchestrator.resume', () => {
  /**
   * The scenario CAPO exists for, minus the part where a human is watching:
   * the run hit a limit, checkpointed, switched, and then its process died
   * (a closed laptop, a reboot, or a wait for both platforms to reset). The
   * checkpoints are on disk. A resume that ignores them throws away exactly
   * the work the checkpoints were written to save.
   */
  it('hands each relaunched session its own checkpoint from disk', async () => {
    const { orch, claude, state, dir, config, adapters } = await harness();
    await orch.start();
    claude.emit('root', { kind: 'usage-limit', raw: 'limit' });
    await once(orch.events, 'switched');

    const set = await latestCheckpointSet(dir);
    expect(set?.checkpoints).toHaveLength(3);

    // A brand new Orchestrator over the same run directory: no in-memory
    // state carried over, exactly like a fresh process.
    const revived = new Orchestrator({
      config, runDir: dir, state, adapters, log: () => {},
    });
    const codex = adapters.get('codex')!;
    const before = codex.started.length;

    const index = await revived.resume();
    expect(index).toBe(set!.index);

    const relaunched = codex.started.slice(before);
    expect(relaunched.map((s) => s.sessionId).sort()).toEqual(['root', 'team-a', 'team-b']);

    for (const launch of relaunched) {
      expect(launch.systemPrompt, `${launch.sessionId} got its own checkpoint`)
        .toContain(`# Checkpoint: ${launch.sessionId}`);
      for (const other of ['root', 'team-a', 'team-b'].filter((id) => id !== launch.sessionId)) {
        expect(launch.systemPrompt, `${launch.sessionId} did not get ${other}'s`)
          .not.toContain(`# Checkpoint: ${other}`);
      }
    }
  });

  it('resumes on the platform the run was left on, not the one it started on', async () => {
    const { orch, claude, state, dir, config, adapters } = await harness();
    await orch.start();
    claude.emit('root', { kind: 'usage-limit', raw: 'limit' });
    await once(orch.events, 'switched');
    expect(state.get().activePlatform).toBe('codex');

    const revived = new Orchestrator({ config, runDir: dir, state, adapters, log: () => {} });
    const claudeBefore = adapters.get('claude')!.started.length;
    const codexBefore = adapters.get('codex')!.started.length;

    await revived.resume();

    expect(adapters.get('codex')!.started.length).toBe(codexBefore + 3);
    expect(adapters.get('claude')!.started.length).toBe(claudeBefore);
  });

  it('launches clean when the run died before it ever paused', async () => {
    const { state, dir, config, adapters } = await harness();
    // No start(), no pause: nothing on disk to resume from.
    const revived = new Orchestrator({ config, runDir: dir, state, adapters, log: () => {} });

    await expect(revived.resume()).resolves.toBeUndefined();
    const started = adapters.get('claude')!.started;
    expect(started.map((s) => s.sessionId).sort()).toEqual(['root', 'team-a', 'team-b']);
    for (const launch of started) {
      // The checkpoint REQUEST instructions legitimately contain the template
      // line `# Checkpoint: <your own session id>`, so assert against the
      // filled-in form: no session may arrive carrying a real checkpoint.
      expect(launch.systemPrompt).not.toContain(`# Checkpoint: ${launch.sessionId}`);
      expect(launch.systemPrompt).not.toContain('checkpoint from the previous platform');
    }
  });
});

describe('resume clears limits that no longer apply', () => {
  it('drops a limit with no known reset time so the run is not stuck forever', async () => {
    const { orch, claude, codex, state, dir, config, adapters } = await harness();
    await orch.start();
    // Neither platform told us when it resets: both are capped indefinitely,
    // which is correct for automatic scheduling and fatal for a manual resume
    // unless the records are cleared.
    claude.emit('root', { kind: 'usage-limit', raw: 'no reset time' });
    await once(orch.events, 'switched');
    codex.emit('root', { kind: 'usage-limit', raw: 'no reset time' });
    await once(orch.events, 'waiting');
    expect(state.get().status).toBe('waiting');
    expect(Object.keys(state.get().limits).sort()).toEqual(['claude', 'codex']);

    const revived = new Orchestrator({ config, runDir: dir, state, adapters, log: () => {} });
    await revived.resume();

    expect(state.get().limits).toEqual({});
    expect(state.get().status).toBe('running');
  });

  it('keeps a limit whose reset time is still in the future', async () => {
    const { orch, claude, state, dir, config, adapters } = await harness();
    await orch.start();
    const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    claude.emit('root', { kind: 'usage-limit', resetAt, raw: 'limited' });
    await once(orch.events, 'switched');

    const revived = new Orchestrator({ config, runDir: dir, state, adapters, log: () => {} });
    await revived.resume();

    expect(state.get().limits['claude']?.resetAt).toBe(resetAt);
  });
});
