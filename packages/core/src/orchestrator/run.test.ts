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
import { renderCheckpoint } from '../checkpoint/render.js';
import type { AdapterSession, Checkpoint, StartSessionOptions } from '../types.js';
import { Orchestrator } from './run.js';
import { CHECKPOINT_REQUEST, MAX_RESULT_NUDGES } from './prompt.js';

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

/** Renders a fenced result block a coordinator's text output is expected to look like. */
function resultBlock(taskId: string, commit: string, evidence = 'tests pass'): string {
  return ['```markdown', `# Result: ${taskId}`, `task: ${taskId}`, `commit: ${commit}`, '', '## Evidence', evidence, '```'].join(
    '\n',
  );
}

/** Writes `relPath` in `worktree` and commits it, returning the new commit sha. */
async function commitInWorktree(worktree: string, relPath: string, content: string): Promise<string> {
  const dir = relPath.split('/').slice(0, -1).join('/');
  if (dir) await mkdir(join(worktree, dir), { recursive: true });
  await writeFile(join(worktree, relPath), content);
  const sha = await commitAll(worktree, `work: ${relPath}`, { name: 't', email: 't@t' });
  if (!sha) throw new Error(`commitInWorktree: nothing to commit for ${relPath}`);
  return sha;
}

/** A path inside `task`'s own declared write scope, for a commit that must be accepted. */
function inScopeFile(task: { id: string; writeScope: string[] }): string {
  return `${task.writeScope[0]}${task.id}.txt`;
}

async function harness(
  makeAdapter: (id: string) => FakeAdapter = (id) => new ArmedFakeAdapter(id),
  /** Test-only seams for the stall watchdog: real milliseconds, not part of
   * CONFIG_YAML, so most tests never have to think about it. */
  watchdog: { stallTimeoutMs?: number; stallPollMs?: number } = {},
  /** Extra raw YAML appended to CONFIG_YAML, e.g. a `check_command` line. */
  extraYaml = '',
  /** Extra `tasks:` entries, spliced in before `limits:` where they belong. */
  extraTasks = '',
): Promise<{
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
  // A repo-local identity, so the suite does not depend on the developer's
  // global git config -- and so it exercises the same path a real user is on,
  // where integration's merge commits use the repository's own identity. CI
  // has none configured, which is how the missing preflight was found.
  await git(workspace, ['config', 'user.email', 'capo-tests@example.com']);
  await git(workspace, ['config', 'user.name', 'CAPO tests']);
  await writeFile(join(workspace, 'README.md'), '# demo\n');
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
  let yaml =
    (watchdog.stallTimeoutMs === undefined
      ? CONFIG_YAML
      : `${CONFIG_YAML}\nstall_timeout_ms: ${watchdog.stallTimeoutMs}\n`) + extraYaml;
  if (extraTasks) yaml = yaml.replace('\nlimits:', `${extraTasks}\nlimits:`);
  await writeFile(configPath, yaml);
  const config = await loadConfig(configPath);

  const claude = makeAdapter('claude');
  const codex = makeAdapter('codex');

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

  const orch = new Orchestrator({
    config,
    runDir: runDirPath,
    state,
    adapters,
    log: () => {},
    stallPollMs: watchdog.stallPollMs,
  });

  return { orch, claude, codex, state, dir: runDirPath, config, adapters };
}

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  // An orchestrator left running keeps pumping events and writing state.json
  // into the directory about to be removed, which races the rm and fails it
  // with ENOTEMPTY. Calling stop() here would be tidier but runs a full
  // checkpoint round per test, taking the suite from 3s to 33s. Letting
  // in-flight writes land and retrying the removal costs nothing and fixes
  // the flake.
  await settle();
  await Promise.all(
    dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })),
  );
});

describe('Orchestrator', () => {
  it('starts a root and one session per coordinator on the configured platform', async () => {
    const { orch, claude } = await harness();
    await orch.start();
    expect(claude.started.map((s) => s.sessionId).sort()).toEqual(['root', 'team-a', 'team-b']);
    expect(claude.started.find((s) => s.sessionId === 'root')!.model).toBe('opus');
    expect(claude.started.find((s) => s.sessionId === 'team-a')!.model).toBe('sonnet');
  });

  it('launches the root supervised (read-only) and coordinators with the configured autonomy', async () => {
    const { orch, claude } = await harness();
    await orch.start();
    const starts = claude.started;
    const root = starts.find((s) => s.role === 'root');
    const coord = starts.find((s) => s.role === 'coordinator');
    expect(root?.autonomy).toBe('supervised');
    expect(coord?.autonomy).toBe('autonomous');
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

describe('worktree branch naming', () => {
  /**
   * Branches live in the repository and outlive `.capo/`. A second run, or a
   * retry after a failed one, must not collide: `git worktree add -b` fails
   * hard on an existing branch and the orchestrator dies before launching
   * anything.
   */
  it('scopes each branch to the run id and the coordinator that works in it', async () => {
    const { orch, state } = await harness();
    await orch.start();
    const runId = state.get().runId;
    for (const task of Object.values(state.get().tasks)) {
      expect(task.branch, task.id).toBe(`capo/${runId}/${task.coordinator}`);
    }
  });

  it('gives two runs in one repository different branch names', async () => {
    const a = await harness();
    await a.orch.start();
    const b = await harness();
    await b.orch.start();
    const branchesA = Object.values(a.state.get().tasks).map((t) => t.branch);
    const branchesB = Object.values(b.state.get().tasks).map((t) => t.branch);
    // Same harness uses the same run id, so compare shape rather than value:
    // every branch must carry its own run id segment.
    for (const br of [...branchesA, ...branchesB]) {
      expect(br).toMatch(/^capo\/[^/]+\/[^/]+$/);
    }
  });
});

describe('checkpoint metadata is CAPO\'s, not the session\'s', () => {
  /**
   * A live Codex agent returned a well-formed checkpoint with every header
   * field blank: run, role, platform, written and base_commit all empty. A
   * session has no reliable way to know its run id or the base commit, and
   * asking it to restate them invites a confident wrong answer. CAPO stamps
   * them instead, and discards whatever the session claimed.
   */
  class LyingAdapter extends FakeAdapter {
    override async start(opts: StartSessionOptions): Promise<AdapterSession> {
      const session = await super.start(opts);
      this.replyWithCheckpoint(opts.sessionId, {
        sessionId: 'not-me',
        runId: '',
        role: 'worker',
        platform: 'some-other-platform',
        written: '',
        baseCommit: '',
        objective: `real narrative for ${opts.sessionId}`,
        decisions: ['a decision the session actually made'],
        done: [], inProgress: [], remaining: [], blockers: [],
      });
      return session;
    }
  }

  it('overwrites blank or wrong metadata while keeping the narrative', async () => {
    const { orch, state, dir, config } = await harness(
      (id) => new LyingAdapter(id),
    );
    await orch.start();
    // Migrated from a usage-limit trigger: a usage-limit pause no longer asks
    // any session for a checkpoint at all (see the "checkpoint retry and
    // usage-limit skip" describe block below), so it can no longer carry a
    // session-written narrative to assert against. `user-switch` still
    // requests a checkpoint from every live session, which is what this test
    // is actually about: CAPO's own facts overwrite the session's claims,
    // while the session's own narrative survives untouched.
    await orch.requestSwitch('codex', 'user-switch');

    const set = (await latestCheckpointSet(dir))!;
    for (const cp of set.checkpoints) {
      expect(cp.runId, 'run id').toBe(state.get().runId);
      expect(cp.baseCommit, 'base commit').toBe(state.get().baseCommit);
      expect(cp.baseCommit).not.toBe('');
      expect(cp.written).not.toBe('');
      expect(cp.sessionId).not.toBe('not-me');
      expect(cp.platform).toBe('claude');
      // The narrative, which only the session knows, survives untouched.
      expect(cp.objective).toContain('real narrative');
      expect(cp.decisions).toEqual(['a decision the session actually made']);
    }
    const root = set.checkpoints.find((c) => c.sessionId === 'root');
    expect(root?.role, 'role comes from CAPO, not the session').toBe('root');
    expect(config).toBeDefined();
  });
});

describe('checkpoints that survive a real limit', () => {
  /** A well-formed checkpoint reply, distinguishable from a synthesized one. */
  function realCheckpoint(opts: StartSessionOptions, platform: string): Checkpoint {
    return {
      sessionId: opts.sessionId,
      runId: 'test-run',
      role: opts.role,
      platform,
      written: new Date().toISOString(),
      baseCommit: 'deadbeef',
      objective: `real objective for ${opts.sessionId}`,
      decisions: [],
      done: [],
      inProgress: [],
      remaining: [],
      blockers: [],
    };
  }

  function fenceCheckpoint(cp: Checkpoint): string {
    return '```markdown\n' + renderCheckpoint(cp) + '\n```';
  }

  /**
   * root and team-b answer the checkpoint request normally, on the first
   * ask, exactly like `ArmedFakeAdapter`. team-a's first reply is only a
   * `turn-end` -- standing in for the request landing mid-turn, with the
   * model answering its own turn instead of the checkpoint -- and only its
   * SECOND reply (after the orchestrator asks again at `turn-end`) is a real
   * checkpoint.
   */
  class SlowToAnswerAdapter extends FakeAdapter {
    #teamASends = 0;

    override async start(opts: StartSessionOptions): Promise<AdapterSession> {
      const session = await super.start(opts);
      if (opts.sessionId !== 'team-a') {
        this.replyWithCheckpoint(opts.sessionId, realCheckpoint(opts, this.id));
        return session;
      }

      const adapter = this;
      return {
        ...session,
        async send(text: string): Promise<void> {
          adapter.sent.push({ sessionId: opts.sessionId, text });
          adapter.#teamASends += 1;
          if (adapter.#teamASends === 1) {
            adapter.emit(opts.sessionId, { kind: 'turn-end' });
            return;
          }
          adapter.emit(opts.sessionId, {
            kind: 'text',
            text: fenceCheckpoint(realCheckpoint(opts, adapter.id)),
          });
          adapter.emit(opts.sessionId, { kind: 'turn-end' });
        },
      };
    }
  }

  it('re-sends the checkpoint request once at turn-end when the first went unanswered', async () => {
    const { orch, claude, dir } = await harness((id) => new SlowToAnswerAdapter(id));
    await orch.start();

    await orch.requestSwitch('codex', 'user-switch');

    const set = await latestCheckpointSet(dir);
    const cp = set!.checkpoints.find((c) => c.sessionId === 'team-a')!;
    expect(cp.objective).not.toMatch(/synthesized/);
    const sendsToTeamA = claude.sent.filter((s) => s.sessionId === 'team-a').map((s) => s.text);
    expect(sendsToTeamA.filter((t) => t === CHECKPOINT_REQUEST)).toHaveLength(2);
  });

  it('does not ask sessions on a capped platform for a checkpoint', async () => {
    const { orch, claude, dir } = await harness();
    await orch.start();

    claude.emit('team-a', { kind: 'usage-limit', raw: 'limit', resetAt: future() });
    await withDeadline(once(orch.events, 'switched'), 'switched');

    const sendsTo = (sessionId: string): string[] =>
      claude.sent.filter((s) => s.sessionId === sessionId).map((s) => s.text);
    expect(sendsTo('team-a')).not.toContain(CHECKPOINT_REQUEST);
    expect(sendsTo('root')).not.toContain(CHECKPOINT_REQUEST);

    const set = await latestCheckpointSet(dir);
    expect(set!.checkpoints.every((c) => c.objective.includes('synthesized'))).toBe(true);
  });

  it('augments a coordinator checkpoint with commits and dirty files from its worktree', async () => {
    const { orch, state, dir } = await harness();
    await orch.start();
    const task = Object.values(state.get().tasks).find((t) => t.coordinator === 'team-a')!;

    await writeFile(join(task.worktree!, 'a.txt'), 'content');
    await commitAll(task.worktree!, 'fix: a', { name: 't', email: 't@t' });
    await writeFile(join(task.worktree!, 'notes.txt'), 'wip');

    await orch.requestSwitch('codex', 'user-switch');

    const cp = (await latestCheckpointSet(dir))!.checkpoints.find((c) => c.sessionId === 'team-a')!;
    expect(cp.done.some((d) => /^commit [0-9a-f]{7,} fix: a$/.test(d))).toBe(true);
    expect(cp.inProgress.some((d) => d === 'uncommitted in worktree: notes.txt')).toBe(true);
  });
});

describe('stall watchdog', () => {
  /**
   * A real Codex coordinator once ended its turn asking a human to approve a
   * fix, then sat there forever: nothing else ever arrived on its stream, and
   * nothing in CAPO noticed. These tests stand in for that: a session that
   * goes quiet — for any reason — should become visible without CAPO taking
   * any action on its own.
   */
  async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('marks a live, silent session stalled after stallTimeoutMs, and touches nothing else', async () => {
    const { orch, claude, state } = await harness(undefined, { stallTimeoutMs: 30, stallPollMs: 5 });
    await orch.start();

    await waitFor(() => state.get().sessions['root']?.stalled === true);

    const record = state.get().sessions['root']!;
    expect(record.stalledSince).toBeTruthy();
    // Silence is information, not a verdict: everything else is unchanged.
    expect(record.status).toBe('running');
    expect(state.get().status).toBe('running');
    expect(claude.started).toHaveLength(3);
  });

  it('clears once the stalled session emits another event', async () => {
    const { orch, claude, state } = await harness(undefined, { stallTimeoutMs: 30, stallPollMs: 5 });
    await orch.start();
    await waitFor(() => state.get().sessions['root']?.stalled === true);

    claude.emit('root', { kind: 'tool', name: 'still-working' });
    await waitFor(() => state.get().sessions['root']?.stalled === false);

    expect(state.get().sessions['root']!.stalledSince).toBeUndefined();
  });

  it('never flags a session that keeps emitting events', async () => {
    // The margin between the poke interval and the timeout has to be wider
    // than ordinary scheduling jitter, or this test fails on a loaded
    // machine for reasons that have nothing to do with the watchdog: at a
    // 40ms timeout with 10ms pokes, one slow `setTimeout` on a busy CI
    // runner is enough to trip it. A 10x margin needs a 200ms stall to
    // produce a false positive. The loop still runs for longer than the
    // timeout, so a watchdog that ignored events entirely would still fire.
    const { orch, claude, state } = await harness(undefined, { stallTimeoutMs: 200, stallPollMs: 20 });
    await orch.start();

    const until = Date.now() + 600;
    while (Date.now() < until) {
      claude.emit('root', { kind: 'tool', name: 'poke' });
      await new Promise((r) => setTimeout(r, 20));
      // Checked every pass, not only at the end: a flag that was raised and
      // then cleared by the next poke would otherwise go unnoticed.
      expect(state.get().sessions['root']?.stalled).not.toBe(true);
    }
  });
});

describe('sessions run in their own worktree', () => {
  /**
   * CAPO creates a worktree per task and records it, but every session was
   * launched with cwd set to the shared workspace, so the worktrees were dead
   * weight. A live run proved it: two real coordinators edited the same
   * checkout while their worktrees still held the original code. Write scopes,
   * isolation and integration all depend on this being right.
   */
  it('gives a coordinator with one task that task worktree', async () => {
    const { orch, claude, state } = await harness();
    await orch.start();
    for (const [id, task] of Object.entries(state.get().tasks)) {
      const launch = claude.started.find((s) => s.sessionId === task.coordinator);
      expect(launch, `a launch for ${task.coordinator}`).toBeDefined();
      expect(launch!.cwd, `${id} runs in its worktree`).toBe(task.worktree);
    }
  });

  // The multi-task case used to fall back to the shared workspace: a
  // coordinator with two tasks got no isolation at all, which is exactly the
  // configuration where isolation matters most. A coordinator is one session
  // with one working directory, so the coordinator -- not the task -- is the
  // unit that can be isolated.
  it('isolates a coordinator that owns several tasks instead of dropping it in the workspace', async () => {
    const extra = `
  - id: task-c
    coordinator: team-a
    brief: ./tasks/a.md
    write_scope: [src/c/]
`;
    const { orch, claude, state, config } = await harness(undefined, {}, '', extra);
    await orch.start();

    const owned = Object.values(state.get().tasks).filter((t) => t.coordinator === 'team-a');
    expect(owned.length).toBe(2);

    const launch = claude.started.find((s) => s.sessionId === 'team-a')!;
    expect(launch.cwd).not.toBe(config.workspace);
    // Both tasks live in the one directory that session actually sits in.
    for (const task of owned) expect(task.worktree).toBe(launch.cwd);
  });

  it('keeps the root in the workspace, since it integrates', async () => {
    const { orch, claude, config } = await harness();
    await orch.start();
    const root = claude.started.find((s) => s.sessionId === 'root')!;
    expect(root.cwd).toBe(config.workspace);
  });

  it('does not put two coordinators in the same directory', async () => {
    const { orch, claude } = await harness();
    await orch.start();
    const coordinators = claude.started.filter((s) => s.role === 'coordinator');
    expect(coordinators.length).toBeGreaterThan(1);
    expect(new Set(coordinators.map((s) => s.cwd)).size).toBe(coordinators.length);
  });
});

describe('task state machine', () => {
  it('moves a task from ready to running the moment its coordinator launches', async () => {
    const { orch, state } = await harness();
    await orch.start();
    const tasks = Object.values(state.get().tasks);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(task.state).toBe('running');
  });

  it('does not regress a task past ready on a relaunch after a switch', async () => {
    const { orch, claude, codex, state } = await harness();
    await orch.start();
    claude.emit('root', { kind: 'usage-limit', raw: 'x' });
    await withDeadline(once(orch.events, 'switched'), 'switched');
    // The relaunch on codex reuses the same session ids; a task already
    // `running` must not be reset by the second launch.
    for (const task of Object.values(state.get().tasks)) expect(task.state).toBe('running');
    expect(codex.started.map((s) => s.sessionId).sort()).toEqual(['root', 'team-a', 'team-b']);
  });
});

describe('result submission', () => {
  it('moves a task to review, records the commit and evidence, and emits result-received', async () => {
    const { orch, claude, state } = await harness();
    await orch.start();
    const task = Object.values(state.get().tasks)[0]!;
    const sha = await commitInWorktree(task.worktree!, inScopeFile(task), 'done\n');

    const received = withDeadline(once(orch.events, 'result-received'), 'result-received');
    claude.emit(task.coordinator, { kind: 'text', text: resultBlock(task.id, sha, 'ran the tests, all green') });
    const [payload] = (await received) as [{ taskId: string; sessionId: string; resultCommit: string }];

    expect(payload.taskId).toBe(task.id);
    expect(payload.resultCommit).toBe(sha);

    const updated = state.get().tasks[task.id]!;
    expect(updated.state).toBe('review');
    expect(updated.resultCommit).toBe(sha);
    expect(updated.evidence).toBe('ran the tests, all green');
  });

  it('resolves the task from ownership, not the session\'s own claim, when unambiguous', async () => {
    const { orch, claude, state } = await harness();
    await orch.start();
    const [taskA, taskB] = Object.values(state.get().tasks);
    const shaA = await commitInWorktree(taskA!.worktree!, inScopeFile(taskA!), 'done\n');
    // team-a owns only task-a. A block that names task-b (wrongly, or from a
    // stale prompt) must still land on the task team-a actually owns -- the
    // same trust boundary `#stampCheckpoint` draws for checkpoint metadata.
    const received = withDeadline(once(orch.events, 'result-received'), 'result-received');
    claude.emit(taskA!.coordinator, { kind: 'text', text: resultBlock(taskB!.id, shaA) });
    await received;
    expect(state.get().tasks[taskA!.id]!.state).toBe('review');
    expect(state.get().tasks[taskA!.id]!.resultCommit).toBe(shaA);
    expect(state.get().tasks[taskB!.id]!.state).toBe('running');
  });

  it('does not crash the pump on a sparse result block, and ignores plain text with no fenced block', async () => {
    const { orch, claude, state } = await harness();
    await orch.start();
    const task = Object.values(state.get().tasks)[0]!;

    // Well-formed heading, everything else blank: parseResult must not throw,
    // and the lenient read still moves the task to review -- acceptResult is
    // what actually catches an unusable (empty) commit sha, at integration time.
    const received = withDeadline(once(orch.events, 'result-received'), 'result-received');
    claude.emit(task.coordinator, { kind: 'text', text: '```markdown\n# Result: \ntask:\n```' });
    await received;
    expect(state.get().tasks[task.id]!.state).toBe('review');

    // Plain prose with no fenced block at all must never be mistaken for a result.
    claude.emit(task.coordinator, { kind: 'text', text: 'still working on it' });
    await settle();
    expect(state.get().tasks[task.id]!.state).toBe('review');
  });
});

describe('result nudges', () => {
  it('nudges a coordinator whose turn ended with its task still running, at most MAX_RESULT_NUDGES times', async () => {
    const { orch, claude, state } = await harness((id) => new FakeAdapter(id));
    await orch.start();
    const task = Object.values(state.get().tasks).find((t) => t.coordinator === 'team-a')!;

    for (let i = 0; i < 5; i++) {
      claude.emit('team-a', { kind: 'turn-end' });
      await settle();
    }

    const sendsToTeamA = claude.sent.filter((s) => s.sessionId === 'team-a').map((s) => s.text);
    const nudges = sendsToTeamA.filter((t) => t.startsWith('CAPO: your turn ended'));
    expect(nudges).toHaveLength(MAX_RESULT_NUDGES);
    expect(nudges[0]).toContain(task.id);
  });

  it('does not nudge once the task has reported a result', async () => {
    const { orch, claude, state } = await harness((id) => new FakeAdapter(id));
    await orch.start();
    const task = Object.values(state.get().tasks).find((t) => t.coordinator === 'team-a')!;
    const sha = await commitInWorktree(task.worktree!, inScopeFile(task), 'done\n');

    const received = withDeadline(once(orch.events, 'result-received'), 'result-received');
    claude.emit('team-a', { kind: 'text', text: resultBlock(task.id, sha) });
    await received;

    claude.emit('team-a', { kind: 'turn-end' });
    await settle();

    const nudges = claude.sent.filter((s) => s.sessionId === 'team-a' && s.text.startsWith('CAPO: your turn ended'));
    expect(nudges).toHaveLength(0);
  });

  it('does not nudge the root, which never owns a task', async () => {
    const { orch, claude } = await harness((id) => new FakeAdapter(id));
    await orch.start();

    claude.emit('root', { kind: 'turn-end' });
    await settle();

    expect(claude.sent.filter((s) => s.sessionId === 'root')).toHaveLength(0);
  });

  it('does not nudge while a switch is in flight', async () => {
    const { orch, claude, codex } = await harness();
    await orch.start();

    await orch.requestSwitch('codex', 'user-switch');

    const nudges = [...claude.sent, ...codex.sent].filter((s) => s.text.startsWith('CAPO: your turn ended'));
    expect(nudges).toHaveLength(0);
  });
});

describe('integration', () => {
  it('integrates once every task has a result, marks everything done, and closes every session', async () => {
    const { orch, claude, state } = await harness();
    await orch.start();
    const tasks = Object.values(state.get().tasks);

    const finished = withDeadline(once(orch.events, 'integration-finished'), 'integration-finished');
    for (const task of tasks) {
      const sha = await commitInWorktree(task.worktree!, inScopeFile(task), 'done\n');
      claude.emit(task.coordinator, { kind: 'text', text: resultBlock(task.id, sha) });
    }
    const [report] = (await finished) as [{ status: string; merged: string[]; checksPassed: boolean }];

    expect(report.status).toBe('done');
    expect(report.merged.sort()).toEqual(tasks.map((t) => t.id).sort());
    expect(report.checksPassed).toBe(true);
    expect(state.get().status).toBe('done');
    for (const task of tasks) expect(state.get().tasks[task.id]!.state).toBe('done');
    expect(claude.closed.sort()).toEqual(['root', 'team-a', 'team-b']);
  });

  it('fails the task and the run when a result writes outside its declared scope', async () => {
    const { orch, claude, state } = await harness();
    await orch.start();
    const tasks = Object.values(state.get().tasks);
    const [taskA, taskB] = tasks;

    const finished = withDeadline(once(orch.events, 'integration-finished'), 'integration-finished');
    // task-a's coordinator commits into task-b's territory: out of scope.
    const badSha = await commitInWorktree(taskA!.worktree!, 'src/b/sneak.txt', 'sneaky\n');
    const goodSha = await commitInWorktree(taskB!.worktree!, inScopeFile(taskB!), 'done\n');
    claude.emit(taskA!.coordinator, { kind: 'text', text: resultBlock(taskA!.id, badSha) });
    claude.emit(taskB!.coordinator, { kind: 'text', text: resultBlock(taskB!.id, goodSha) });
    await finished;

    expect(state.get().status).toBe('failed');
    const failedTask = state.get().tasks[taskA!.id]!;
    expect(failedTask.state).toBe('failed');
    expect(failedTask.note).toMatch(/rejected/i);
    expect(state.get().tasks[taskB!.id]!.state).toBe('done');
  });

  it('fails every merged task when the combined check command fails', async () => {
    const { orch, claude, state } = await harness(
      undefined,
      {},
      '\ncheck_command: ["node", "-e", "process.exit(1)"]\n',
    );
    await orch.start();
    const tasks = Object.values(state.get().tasks);

    const finished = withDeadline(once(orch.events, 'integration-finished'), 'integration-finished');
    for (const task of tasks) {
      const sha = await commitInWorktree(task.worktree!, inScopeFile(task), 'done\n');
      claude.emit(task.coordinator, { kind: 'text', text: resultBlock(task.id, sha) });
    }
    const [report] = (await finished) as [{ status: string; checksPassed: boolean }];

    expect(report.checksPassed).toBe(false);
    expect(report.status).toBe('failed');
    expect(state.get().status).toBe('failed');
    for (const task of tasks) {
      expect(state.get().tasks[task.id]!.state).toBe('failed');
      expect(state.get().tasks[task.id]!.note).toMatch(/check/i);
    }
  });

  it('does not integrate until every task has reported', async () => {
    const { orch, claude, state } = await harness();
    await orch.start();
    const [taskA] = Object.values(state.get().tasks);
    const sha = await commitInWorktree(taskA!.worktree!, inScopeFile(taskA!), 'done\n');
    const received = withDeadline(once(orch.events, 'result-received'), 'result-received');
    claude.emit(taskA!.coordinator, { kind: 'text', text: resultBlock(taskA!.id, sha) });
    await received;
    await settle();
    expect(state.get().status).toBe('running');
    expect(state.get().tasks[taskA!.id]!.state).toBe('review');
  });

  it('finishes integration on resume when a crash landed after every result but before integration ran', async () => {
    const { orch, state, dir, config, adapters } = await harness();
    await orch.start();
    const tasks = Object.values(state.get().tasks);

    const shas = new Map<string, string>();
    for (const task of tasks) {
      shas.set(task.id, await commitInWorktree(task.worktree!, inScopeFile(task), 'done\n'));
    }

    // Simulate a crash that landed after every result was already durably
    // recorded in state.json (exactly what `#handleResult` writes) but before
    // the orchestrator got to integrate them.
    await state.update((draft) => {
      for (const task of Object.values(draft.tasks)) {
        task.state = 'review';
        task.resultCommit = shas.get(task.id);
        task.evidence = 'tests pass';
      }
    });

    const revived = new Orchestrator({ config, runDir: dir, state, adapters, log: () => {} });
    const finished = withDeadline(once(revived.events, 'integration-finished'), 'integration-finished');
    await revived.resume();
    await finished;

    expect(state.get().status).toBe('done');
    for (const task of tasks) expect(state.get().tasks[task.id]!.state).toBe('done');
  });
  // A live Codex run whose every session failed on an unsupported model kept
  // reporting "running" forever: nothing watched for the case where there is
  // no longer anyone left who could finish the work.
  it('ends the run when every session has died with the work unfinished', async () => {
    const { orch, state, claude } = await harness();
    await orch.start();

    const abandoned = withDeadline(once(orch.events, 'abandoned'), 'abandoned');
    for (const id of ['root', 'team-a', 'team-b']) {
      claude.emit(id, { kind: 'error', message: 'model not supported', retryable: false });
    }
    await settle();
    for (const id of ['root', 'team-a', 'team-b']) claude.endStream(id);

    const [report] = (await abandoned) as [{ reason: string; failed: string[] }];
    expect(report.failed.sort()).toEqual(['root', 'team-a', 'team-b']);
    expect(state.get().status).toBe('failed');
  });

  it('does not end the run when one session dies but others are still working', async () => {
    const { orch, state, claude } = await harness();
    await orch.start();

    claude.endStream('team-b');
    // The pump records a session's end a few real I/O round-trips after the
    // stream closes (a state write and a STATUS.md write), so poll on a
    // timer rather than guessing a number of microtask turns.
    for (let i = 0; i < 100 && state.get().sessions['team-b']!.status !== 'stopped'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(state.get().sessions['team-b']!.status).toBe('stopped');
    expect(state.get().status).toBe('running');
  });
  // CI had no git identity and reached integration with every coordinator's
  // work already done, then lost all of it: the merge failed for a reason
  // that was not a conflict, `merge --abort` threw on top of it, and every
  // task stayed at `review` with a failed run above it and no stated reason.
  it('refuses to start when git has no author identity, before spending a single model call', async () => {
    const { orch, config, claude } = await harness();
    // Empty rather than unset: a repo-local empty identity overrides whatever
    // the developer has configured globally, so this behaves the same on a
    // laptop with a git identity and on CI without one.
    await git(config.workspace, ['config', 'user.email', '']);
    await git(config.workspace, ['config', 'user.name', '']);

    await expect(orch.start()).rejects.toThrow(/identity/i);
    expect(claude.started).toEqual([]);
  });

  it('explains itself in the task table when integration cannot run at all', async () => {
    const { orch, claude, state, config } = await harness();
    await orch.start();
    const tasks = Object.values(state.get().tasks);

    // Identity emptied after launch: every session has already done its work,
    // and the merge integration is about to attempt cannot be committed.
    await git(config.workspace, ['config', 'user.email', '']);
    await git(config.workspace, ['config', 'user.name', '']);

    const finished = withDeadline(once(orch.events, 'integration-finished'), 'integration-finished');
    for (const task of tasks) {
      const sha = await commitInWorktree(task.worktree!, inScopeFile(task), 'done\n');
      claude.emit(task.coordinator, { kind: 'text', text: resultBlock(task.id, sha) });
    }
    await finished;

    expect(state.get().status).toBe('failed');
    for (const task of tasks) {
      expect(state.get().tasks[task.id]!.note).toMatch(/integration could not run/i);
    }
  });
});
