import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptResult, integrate } from './merge.js';
import { git, headCommit, addWorktree, commitAll } from '../git/repo.js';
import type { TaskRecord } from '../types.js';

let repo: string;

/** Tests must not depend on the developer's global git config. */
const ID = { name: 't', email: 't@t' };
// The plan's worktree helper puts each worktree at join(repo, '..', 'wt-<id>'),
// which collapses to the same sibling-of-tmpdir path across every mkdtemp'd
// repo, and ids repeat across tests (wt-a, wt-b). Track every path created so
// afterEach can remove them -- otherwise a later test's `addWorktree` fails
// with "already exists" against a directory an earlier, already-deleted repo
// left behind.
let worktrees: string[] = [];

const task = (id: string, scope: string[]): TaskRecord => ({
  id, coordinator: `team-${id}`, briefPath: `/x/${id}.md`,
  writeScope: scope, state: 'review',
});

async function seed(): Promise<string> {
  await mkdir(join(repo, 'src/a'), { recursive: true });
  await mkdir(join(repo, 'src/b'), { recursive: true });
  await writeFile(join(repo, 'src/a/keep.ts'), 'export const a = 1;\n');
  await writeFile(join(repo, 'src/b/keep.ts'), 'export const b = 1;\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  return headCommit(repo);
}

// Helper: make a commit on a worktree branch touching the given files.
async function work(id: string, base: string, files: Record<string, string>): Promise<string> {
  const wt = join(repo, '..', `wt-${id}`);
  worktrees.push(wt);
  await addWorktree(repo, wt, `capo/${id}`, base);
  for (const [f, body] of Object.entries(files)) {
    await mkdir(join(wt, f.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(join(wt, f), body);
  }
  const sha = await commitAll(wt, `work ${id}`, ID);
  return sha!;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'capo-int-'));
  worktrees = [];
  await git(repo, ['init', '-q', '.']);
});
afterEach(async () => {
  await Promise.all(worktrees.map(wt => rm(wt, { recursive: true, force: true })));
  await rm(repo, { recursive: true, force: true });
});

describe('acceptResult', () => {
  it('accepts a result that stays inside its write scope', async () => {
    const base = await seed();
    const sha = await work('a', base, { 'src/a/new.ts': 'export const n = 1;\n' });
    const out = await acceptResult(repo, { ...task('a', ['src/a/']), baseCommit: base },
      { taskId: 'a', baseCommit: base, resultCommit: sha, evidence: '4 tests pass' });
    expect(out).toEqual({ accepted: true, violations: [] });
  });

  it('rejects a result that writes outside its scope', async () => {
    const base = await seed();
    const sha = await work('a', base, { 'src/b/sneak.ts': 'export const s = 1;\n' });
    const out = await acceptResult(repo, { ...task('a', ['src/a/']), baseCommit: base },
      { taskId: 'a', baseCommit: base, resultCommit: sha, evidence: 'ok' });
    expect(out.accepted).toBe(false);
    expect(out.violations).toEqual(['src/b/sneak.ts']);
  });

  it('rejects a file renamed out of scope', async () => {
    const base = await seed();
    const wt = join(repo, '..', 'wt-r');
    worktrees.push(wt);
    await addWorktree(repo, wt, 'capo/r', base);
    await git(wt, ['mv', 'src/a/keep.ts', 'src/b/moved.ts']);
    const sha = (await commitAll(wt, 'move', ID))!;
    const out = await acceptResult(repo, { ...task('a', ['src/a/']), baseCommit: base },
      { taskId: 'a', baseCommit: base, resultCommit: sha, evidence: 'ok' });
    expect(out.accepted).toBe(false);
    expect(out.violations).toContain('src/b/moved.ts');
  });

  it('rejects a submission whose base does not match the task record', async () => {
    const base = await seed();
    const sha = await work('a', base, { 'src/a/n.ts': 'x\n' });
    const out = await acceptResult(repo, { ...task('a', ['src/a/']), baseCommit: 'deadbeef' },
      { taskId: 'a', baseCommit: base, resultCommit: sha, evidence: 'ok' });
    expect(out.accepted).toBe(false);
    expect(out.reason).toMatch(/base/i);
  });

  it('rejects a submission naming a commit that does not exist', async () => {
    const base = await seed();
    const out = await acceptResult(repo, { ...task('a', ['src/a/']), baseCommit: base },
      { taskId: 'a', baseCommit: base, resultCommit: 'f'.repeat(40), evidence: 'ok' });
    expect(out.accepted).toBe(false);
    expect(out.reason).toMatch(/not found|unknown revision/i);
  });
});

describe('integrate', () => {
  it('merges two non-overlapping task results and runs the combined check', async () => {
    const base = await seed();
    const a = await work('a', base, { 'src/a/new.ts': 'export const n = 1;\n' });
    const b = await work('b', base, { 'src/b/new.ts': 'export const m = 1;\n' });
    const rep = await integrate({
      identity: ID,
      repo, runDir: join(repo, '.capo/runs/r1'), baseCommit: base,
      tasks: [{ ...task('a', ['src/a/']), baseCommit: base }, { ...task('b', ['src/b/']), baseCommit: base }],
      submissions: new Map([
        ['a', { taskId: 'a', baseCommit: base, resultCommit: a, evidence: 'ok' }],
        ['b', { taskId: 'b', baseCommit: base, resultCommit: b, evidence: 'ok' }],
      ]),
      checkCommand: ['node', '-e', 'process.exit(0)'],
    });
    expect(rep.merged).toEqual(['a', 'b']);
    expect(rep.conflicted).toEqual([]);
    expect(rep.checksPassed).toBe(true);
  });

  // A merge can fail for reasons that have nothing to do with the diffs. When
  // it does, git leaves no MERGE_HEAD, so the unconditional `merge --abort`
  // that used to follow threw a second error out of integrate() -- and the
  // caller, seeing only that, had no task outcomes at all. A non-conflict
  // failure must surface as itself, not as a conflict with no files.
  it('surfaces a merge that failed for a non-conflict reason instead of calling it a conflict', async () => {
    const base = await seed();
    const a = await work('a', base, { 'src/a/new.ts': 'export const n = 1;\n' });
    // No identity passed and none configurable: the merge commit cannot be
    // written, which is exactly what a machine with no git identity hits.
    await git(repo, ['config', 'user.email', '']);
    await git(repo, ['config', 'user.name', '']);

    await expect(
      integrate({
        repo, runDir: join(repo, '.capo/runs/r-noident'), baseCommit: base,
        tasks: [{ ...task('a', ['src/a/']), baseCommit: base }],
        submissions: new Map([['a', { taskId: 'a', baseCommit: base, resultCommit: a, evidence: 'ok' }]]),
      }),
    ).rejects.toThrow(/identity|ident/i);
  });

  it('reports a conflict on the second task without losing the first', async () => {
    const base = await seed();
    const a = await work('a', base, { 'src/a/keep.ts': 'export const a = 2;\n' });
    const b = await work('b', base, { 'src/a/keep.ts': 'export const a = 3;\n' });
    const rep = await integrate({
      identity: ID,
      repo, runDir: join(repo, '.capo/runs/r1'), baseCommit: base,
      tasks: [{ ...task('a', ['src/a/']), baseCommit: base }, { ...task('b', ['src/a/']), baseCommit: base }],
      submissions: new Map([
        ['a', { taskId: 'a', baseCommit: base, resultCommit: a, evidence: 'ok' }],
        ['b', { taskId: 'b', baseCommit: base, resultCommit: b, evidence: 'ok' }],
      ]),
    });
    expect(rep.merged).toEqual(['a']);
    expect(rep.conflicted).toEqual([{ taskId: 'b', files: ['src/a/keep.ts'] }]);
  });

  it('reports checksPassed false and keeps the output when the check command fails', async () => {
    const base = await seed();
    const a = await work('a', base, { 'src/a/new.ts': 'export const n = 1;\n' });
    const rep = await integrate({
      identity: ID,
      repo, runDir: join(repo, '.capo/runs/r1'), baseCommit: base,
      tasks: [{ ...task('a', ['src/a/']), baseCommit: base }],
      submissions: new Map([['a', { taskId: 'a', baseCommit: base, resultCommit: a, evidence: 'ok' }]]),
      checkCommand: ['node', '-e', 'console.error("2 failing"); process.exit(1)'],
    });
    expect(rep.checksPassed).toBe(false);
    expect(rep.checkOutput).toContain('2 failing');
  });

  it('skips a task with no submission rather than failing the run', async () => {
    const base = await seed();
    const rep = await integrate({
      identity: ID,
      repo, runDir: join(repo, '.capo/runs/r1'), baseCommit: base,
      tasks: [{ ...task('a', ['src/a/']), baseCommit: base }], submissions: new Map(),
    });
    expect(rep.merged).toEqual([]);
    expect(rep.conflicted).toEqual([]);
  });
});
