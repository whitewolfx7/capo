/**
 * The acceptance demo for CAPO v0.1: proves the product's central claim end
 * to end, entirely against `FakeAdapter` so it is deterministic and offline.
 *
 * The claim (docs/architecture.md, "The rule" and "Acceptance demo"):
 * a user runs an agent team on Claude Code, hits their usage limit mid-work,
 * and CAPO moves the whole team to Codex from Markdown checkpoints without
 * losing context -- then, when both platforms are capped, CAPO waits rather
 * than flapping between them.
 *
 * This test scripts exactly that against the real `examples/two-coordinators`
 * project: a root plus two coordinators (team-a, team-b) each own one half of
 * a tiny broken Node project, get checkpointed and switched from Claude to
 * Codex mid-run, "finish" by committing their fix, get independently
 * accepted (or rejected) against their write scope, get merged and checked
 * together, and finally a second limit on Codex drives the run to `waiting`
 * instead of bouncing back to Claude.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import {
  FakeAdapter,
  Orchestrator,
  StateStore,
  acceptResult,
  addWorktree,
  commitAll,
  git,
  integrate,
  latestCheckpointSet,
  loadConfig,
  parseCheckpoint,
  runDir,
} from '@capo/core';
import type {
  AdapterSession,
  Checkpoint,
  ResultSubmission,
  StartSessionOptions,
  TaskRecord,
} from '@capo/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = join(HERE, '..', '..', 'examples', 'two-coordinators');
const IDENTITY = { name: 't', email: 't@t' };

/**
 * A FakeAdapter that arms every session it starts to reply to the very next
 * send() with a checkpoint for itself, so the orchestrator's single
 * CHECKPOINT_REQUEST per session is always answered instantly. Mirrors
 * `ArmedFakeAdapter` in packages/core/src/orchestrator/run.test.ts, written
 * fresh here per Task 13's instructions rather than imported.
 */
class ArmedFakeAdapter extends FakeAdapter {
  override async start(opts: StartSessionOptions): Promise<AdapterSession> {
    const session = await super.start(opts);
    const cp: Checkpoint = {
      sessionId: opts.sessionId,
      runId: 'demo-run',
      role: opts.role,
      platform: this.id,
      written: new Date().toISOString(),
      baseCommit: 'deadbeef',
      objective: `demo objective for ${opts.sessionId} on ${this.id}`,
      decisions: [`chose an approach for ${opts.sessionId}`],
      done: ['read the brief'],
      inProgress: ['implementing the fix'],
      remaining: ['run the tests'],
      blockers: [],
    };
    this.replyWithCheckpoint(opts.sessionId, cp);
    return session;
  }
}

/** An ISO timestamp far enough in the future that a limit recorded with it reads as still active. */
function future(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

/** Race a promise against a bounded timeout so a stalled event can never hang the suite. */
function withDeadline<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)),
  ]);
}

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('acceptance: limit-triggered switch from Claude to Codex', () => {
  it('moves a whole two-coordinator team from claude to codex on a usage limit, without losing context, and waits rather than flaps when codex is capped too', async () => {
    // --- Step 1: a scratch git repo seeded from the real example project ---
    const workspace = await mkdtemp(join(tmpdir(), 'capo-demo-'));
    dirs.push(workspace);
    await cp(EXAMPLE_DIR, workspace, { recursive: true });

    await git(workspace, ['init', '-b', 'main']);
    // Repo-local, so this passes both on a laptop with a global git identity
    // and on CI without one -- the run's own preflight requires it.
    await git(workspace, ['config', 'user.email', IDENTITY.email]);
    await git(workspace, ['config', 'user.name', IDENTITY.name]);
    await git(workspace, ['add', '-A']);
    await commitAll(workspace, 'initial commit: two broken helpers', IDENTITY);

    const config = await loadConfig(join(workspace, 'orchestration.yaml'));

    const runId = 'demo-run';
    const runDirPath = runDir(workspace, runId);
    const state = await StateStore.create(runDirPath, {
      version: 1,
      runId,
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

    const claude = new ArmedFakeAdapter('claude');
    const codex = new ArmedFakeAdapter('codex');
    const adapters = new Map([
      ['claude', claude],
      ['codex', codex],
    ]);

    const orch = new Orchestrator({ config, runDir: runDirPath, state, adapters, log: () => {} });

    // --- Step 2: root + two coordinators start on claude, claude model column ---
    await orch.start();

    expect(claude.started.map((s) => s.sessionId).sort()).toEqual(['root', 'team-a', 'team-b']);
    expect(claude.started.find((s) => s.sessionId === 'root')!.model)
      .toBe(config.models.root['claude']);
    expect(claude.started.find((s) => s.sessionId === 'team-a')!.model)
      .toBe(config.models.coordinator['claude']);
    expect(claude.started.find((s) => s.sessionId === 'team-b')!.model)
      .toBe(config.models.coordinator['claude']);

    // --- Step 3: a usage-limit event arrives from team-a mid-run ---
    claude.emit('team-a', {
      kind: 'usage-limit',
      resetAt: future(),
      raw: 'fake: claude usage limit reached',
    });
    await withDeadline(once(orch.events, 'switched'), 'first switch (claude -> codex)');

    // --- Step 4: checkpoint set 001 exists on disk, reason usage-limit, three files, all parse ---
    const set = await latestCheckpointSet(runDirPath);
    expect(set!.index).toBe(1);
    expect(set!.reason).toBe('usage-limit');
    expect(set!.checkpoints).toHaveLength(3);

    const setDir = join(runDirPath, 'checkpoints', '001');
    const entries = await readdir(setDir);
    const sessionFiles = entries.filter((f) => f !== 'INDEX.md');
    expect(sessionFiles.sort()).toEqual(['root.md', 'team-a.md', 'team-b.md']);

    for (const file of sessionFiles) {
      const markdown = await readFile(join(setDir, file), 'utf8');
      const parsed = parseCheckpoint(markdown);
      expect(parsed.sessionId).toBe(file.replace(/\.md$/, ''));
    }

    // --- Step 5: all three sessions restart on codex, codex model column ---
    expect(codex.started.map((s) => s.sessionId).sort()).toEqual(['root', 'team-a', 'team-b']);
    // Derived from the config rather than pinned to a literal: what matters
    // is that the CODEX column was used, not which model name is in it. Real
    // Codex model names differ per account, so the example carries
    // placeholders.
    expect(codex.started.find((s) => s.sessionId === 'root')!.model)
      .toBe(config.models.root['codex']);
    expect(codex.started.find((s) => s.sessionId === 'team-a')!.model)
      .toBe(config.models.coordinator['codex']);
    expect(codex.started.find((s) => s.sessionId === 'team-b')!.model)
      .toBe(config.models.coordinator['codex']);
    // And that it is genuinely a different column from the one it started on.
    expect(config.models.root['codex']).not.toBe(config.models.root['claude']);
    expect(state.get().activePlatform).toBe('codex');

    // Each relaunched session's prompt carries only its own checkpoint.
    const ALL_SESSION_IDS = ['root', 'team-a', 'team-b'];
    for (const id of ALL_SESSION_IDS) {
      const launch = codex.started.find((s) => s.sessionId === id)!;
      expect(launch.systemPrompt, `${id} got its own checkpoint`).toContain(`# Checkpoint: ${id}`);
      for (const other of ALL_SESSION_IDS.filter((o) => o !== id)) {
        expect(launch.systemPrompt, `${id} did not get ${other}'s checkpoint`).not.toContain(
          `# Checkpoint: ${other}`,
        );
      }
    }

    // --- Step 6: coordinators "finish" by committing a fix in their task worktree ---
    const tasks = state.get().tasks;
    const taskA = tasks['component-a']!;
    const taskB = tasks['component-b']!;
    expect(taskA.worktree).toBeDefined();
    expect(taskB.worktree).toBeDefined();

    await writeFile(
      join(taskA.worktree!, 'src/component-a/add.mjs'),
      'export function add(a, b) {\n  return a + b;\n}\n',
    );
    const commitA = await commitAll(taskA.worktree!, 'fix: add() should add', IDENTITY);

    await writeFile(
      join(taskB.worktree!, 'src/component-b/multiply.mjs'),
      'export function multiply(a, b) {\n  return a * b;\n}\n',
    );
    const commitB = await commitAll(taskB.worktree!, 'fix: multiply() should multiply', IDENTITY);

    expect(commitA).toBeDefined();
    expect(commitB).toBeDefined();

    const subA: ResultSubmission = {
      taskId: 'component-a',
      baseCommit: taskA.baseCommit!,
      resultCommit: commitA!,
      evidence: 'node --test src/component-a passes',
    };
    const subB: ResultSubmission = {
      taskId: 'component-b',
      baseCommit: taskB.baseCommit!,
      resultCommit: commitB!,
      evidence: 'node --test src/component-b passes',
    };

    const outcomeA = await acceptResult(workspace, taskA, subA);
    const outcomeB = await acceptResult(workspace, taskB, subB);
    expect(outcomeA).toEqual({ accepted: true, violations: [] });
    expect(outcomeB).toEqual({ accepted: true, violations: [] });

    // A deliberately out-of-scope third submission is rejected, naming the violating path.
    const violationWorktree = join(runDirPath, 'worktrees', 'component-a-violation');
    await addWorktree(workspace, violationWorktree, 'capo/component-a-violation', taskA.baseCommit!);
    await writeFile(
      join(violationWorktree, 'src/component-b/sneak.mjs'),
      'export const sneak = true;\n',
    );
    const violationCommit = await commitAll(violationWorktree, 'sneaks outside scope', IDENTITY);
    expect(violationCommit).toBeDefined();

    const violatingSub: ResultSubmission = {
      taskId: 'component-a',
      baseCommit: taskA.baseCommit!,
      resultCommit: violationCommit!,
      evidence: 'claims to be done',
    };
    const violationOutcome = await acceptResult(workspace, taskA, violatingSub);
    expect(violationOutcome.accepted).toBe(false);
    expect(violationOutcome.violations).toContain('src/component-b/sneak.mjs');

    // --- Step 7: integrate merges the two accepted results; combined check passes ---
    const report = await integrate({
      repo: workspace,
      runDir: runDirPath,
      baseCommit: state.get().baseCommit,
      tasks: [taskA, taskB],
      submissions: new Map([
        ['component-a', subA],
        ['component-b', subB],
      ]),
      // Explicit paths, not a glob: `node --test 'src/**/*.test.mjs'` only
      // expands globs from Node 22, and package.json declares Node 20 as the
      // floor. CI on Node 20 found this; it passed locally on Node 23.
      checkCommand: [
        'node', '--test',
        'src/component-a/add.test.mjs',
        'src/component-b/multiply.test.mjs',
      ],
      identity: IDENTITY,
    });

    expect(report.merged.sort()).toEqual(['component-a', 'component-b']);
    expect(report.conflicted).toEqual([]);
    expect(report.checksPassed).toBe(true);

    // --- Step 8: a limit on codex too drives the run to waiting, not another switch ---
    const codexRootStartsBeforeSecondLimit = codex.started.filter((s) => s.sessionId === 'root').length;
    const claudeRootStartsBeforeSecondLimit = claude.started.filter((s) => s.sessionId === 'root').length;

    codex.emit('root', {
      kind: 'usage-limit',
      resetAt: future(),
      raw: 'fake: codex usage limit reached too',
    });
    await withDeadline(once(orch.events, 'waiting'), 'both-capped wait');

    expect(state.get().status).toBe('waiting');
    expect(Object.keys(state.get().limits).sort()).toEqual(['claude', 'codex']);

    // No flapping back to claude, and no further codex relaunch either.
    expect(claude.started.filter((s) => s.sessionId === 'root')).toHaveLength(
      claudeRootStartsBeforeSecondLimit,
    );
    expect(codex.started.filter((s) => s.sessionId === 'root')).toHaveLength(
      codexRootStartsBeforeSecondLimit,
    );
  });
});
