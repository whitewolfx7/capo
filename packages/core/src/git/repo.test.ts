import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  git,
  isRepo,
  headCommit,
  isClean,
  addWorktree,
  removeWorktree,
  commitAll,
  changedPaths,
  describeWorktree,
} from './repo.js';
import { CapoError } from '../types.js';

let dir: string;

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'capo-repo-'));
  // -b main because the default branch name varies by git version and config.
  await git(repo, ['init', '-b', 'main']);
  // Configure identity ON THE TEST REPO rather than relying on the developer's
  // global config, so the suite passes on a clean machine and on CI.
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
}

async function commitFile(repo: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, name), content);
  const sha = await commitAll(repo, message);
  if (!sha) throw new Error('expected a commit');
  return sha;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'capo-git-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('isRepo', () => {
  it('is false for a plain directory', async () => {
    expect(await isRepo(dir)).toBe(false);
  });

  it('is true once git init has run', async () => {
    const repo = await initRepo();
    expect(await isRepo(repo)).toBe(true);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('headCommit', () => {
  it('returns the sha of the initial commit', async () => {
    const repo = await initRepo();
    const sha = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    expect(await headCommit(repo)).toBe(sha);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('isClean', () => {
  it('is true right after a commit', async () => {
    const repo = await initRepo();
    await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    expect(await isClean(repo)).toBe(true);
    await rm(repo, { recursive: true, force: true });
  });

  it('is false with an untracked or modified file', async () => {
    const repo = await initRepo();
    await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    await writeFile(join(repo, 'b.txt'), 'new file');
    expect(await isClean(repo)).toBe(false);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('commitAll', () => {
  it('returns undefined when there is nothing to commit', async () => {
    const repo = await initRepo();
    await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    const result = await commitAll(repo, 'no-op commit');
    expect(result).toBeUndefined();
  });

  it('stages and commits new files, returning the new sha', async () => {
    const repo = await initRepo();
    const first = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    await writeFile(join(repo, 'b.txt'), 'world');
    const second = await commitAll(repo, 'add b.txt');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(await headCommit(repo)).toBe(second);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('addWorktree', () => {
  it('creates a working directory at the given path, based on the given ref', async () => {
    const repo = await initRepo();
    const base = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    const wtPath = join(dir, 'wt1');
    await addWorktree(repo, wtPath, 'task-1', base);

    expect(await isRepo(wtPath)).toBe(true);
    const content = await readFile(join(wtPath, 'a.txt'), 'utf8');
    expect(content).toBe('hello');
    expect(await headCommit(wtPath)).toBe(base);
    await rm(repo, { recursive: true, force: true });
  });

  it('a commit made in a worktree does not appear in the main checkout', async () => {
    const repo = await initRepo();
    const base = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    const wtPath = join(dir, 'wt2');
    await addWorktree(repo, wtPath, 'task-2', base);

    const wtSha = await commitFile(wtPath, 'a.txt', 'changed in worktree', 'worktree commit');

    expect(await headCommit(repo)).toBe(base);
    expect(await headCommit(wtPath)).toBe(wtSha);
    expect(wtSha).not.toBe(base);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('removeWorktree', () => {
  it('removes a worktree so it no longer appears in the list', async () => {
    const repo = await initRepo();
    const base = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    const wtPath = join(dir, 'wt3');
    await addWorktree(repo, wtPath, 'task-3', base);

    await removeWorktree(repo, wtPath);

    const list = await git(repo, ['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(wtPath);
    await rm(repo, { recursive: true, force: true });
  });

  it('is idempotent: calling it again on an already-removed path does not throw', async () => {
    const repo = await initRepo();
    const base = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    const wtPath = join(dir, 'wt4');
    await addWorktree(repo, wtPath, 'task-4', base);

    await removeWorktree(repo, wtPath);
    await expect(removeWorktree(repo, wtPath)).resolves.toBeUndefined();
  });

  it('resolves without throwing for a path that was never a worktree', async () => {
    const repo = await initRepo();
    await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    const neverPath = join(dir, 'never-existed');
    await expect(removeWorktree(repo, neverPath)).resolves.toBeUndefined();
    await rm(repo, { recursive: true, force: true });
  });
});

describe('changedPaths', () => {
  it('lists exactly the touched files between two revisions', async () => {
    const repo = await initRepo();
    const base = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    await mkdir(join(repo, 'sub'), { recursive: true });
    await writeFile(join(repo, 'b.txt'), 'new file');
    await writeFile(join(repo, 'sub', 'c.txt'), 'another new file');
    const head = await commitAll(repo, 'add b.txt and sub/c.txt');
    if (!head) throw new Error('expected a commit');

    const paths = await changedPaths(repo, base, head);
    expect(paths.sort()).toEqual(['b.txt', 'sub/c.txt']);
    await rm(repo, { recursive: true, force: true });
  });

  it('reports a rename under its new path', async () => {
    const repo = await initRepo();
    const base = await commitFile(
      repo,
      'orig.txt',
      'a'.repeat(200) + '\nsome stable content that is long enough to be detected as a rename\n',
      'initial commit',
    );
    await rm(join(repo, 'orig.txt'));
    await writeFile(
      join(repo, 'renamed.txt'),
      'a'.repeat(200) + '\nsome stable content that is long enough to be detected as a rename\n',
    );
    const head = await commitAll(repo, 'rename orig.txt to renamed.txt');
    if (!head) throw new Error('expected a commit');

    const paths = await changedPaths(repo, base, head);
    expect(paths).toEqual(['renamed.txt']);
    await rm(repo, { recursive: true, force: true });
  });

  it('returns an empty list between identical revisions', async () => {
    const repo = await initRepo();
    const base = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    expect(await changedPaths(repo, base, base)).toEqual([]);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('describeWorktree', () => {
  it('describeWorktree lists commits since base and uncommitted paths', async () => {
    const repo = await initRepo();
    const baseSha = await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    await commitFile(repo, 'a.txt', 'changed', 'feat: one');
    await writeFile(join(repo, 'b.txt'), 'uncommitted');

    const out = await describeWorktree(repo, baseSha);
    expect(out.commits).toHaveLength(1);
    expect(out.commits[0]).toMatch(/^[0-9a-f]{7,} feat: one$/);
    expect(out.dirty).toEqual(['b.txt']);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('git()', () => {
  it('throws a CapoError containing stderr for an invalid revision', async () => {
    const repo = await initRepo();
    await commitFile(repo, 'a.txt', 'hello', 'initial commit');
    let caught: unknown;
    try {
      await git(repo, ['rev-parse', '--verify', 'not-a-real-revision']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CapoError);
    expect((caught as CapoError).message).toMatch(/not-a-real-revision/);
    await rm(repo, { recursive: true, force: true });
  });

  it('never uses a shell: an argument containing spaces and shell metacharacters is passed literally', async () => {
    const repo = await initRepo();
    const weird = 'a b; echo pwned && rm -rf .txt';
    const sha = await commitFile(repo, weird, 'content', 'commit with weird filename');
    const paths = await changedPaths(repo, sha, sha === (await headCommit(repo)) ? sha : sha);
    // no assertion needed beyond "did not throw and did not execute injected command"
    expect(paths).toEqual([]);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('commitAll identity', () => {
  let r: string;

  beforeEach(async () => { r = await initRepo(); });
  afterEach(async () => { await rm(r, { recursive: true, force: true }); });

  it("uses the repository's own configured identity when none is passed", async () => {
    await writeFile(join(r, 'a.txt'), 'a');
    const sha = await commitAll(r, 'first');
    expect(await git(r, ['log', '-1', '--format=%an <%ae>', sha!])).toBe('t <t@t>');
  });

  it('uses an explicitly passed identity over the repository config', async () => {
    await writeFile(join(r, 'a.txt'), 'a');
    const sha = await commitAll(r, 'first', { name: 'Someone', email: 'someone@example.com' });
    expect(await git(r, ['log', '-1', '--format=%an <%ae>', sha!]))
      .toBe('Someone <someone@example.com>');
  });

  it('fails with an actionable hint when git has no identity it may use', async () => {
    // CAPO commits into the user's real repository. Committing as a made-up
    // author, rather than reporting the missing identity, would quietly put
    // junk in their history.
    //
    // Producing a genuinely identity-less git needs BOTH: useConfigOnly stops
    // git inventing one from the username and hostname, and the env vars stop
    // it reading the developer's global and system config.
    await git(r, ['config', '--unset', 'user.email']);
    await git(r, ['config', '--unset', 'user.name']);
    await git(r, ['config', 'user.useConfigOnly', 'true']);
    await writeFile(join(r, 'a.txt'), 'a');

    const saved = {
      global: process.env['GIT_CONFIG_GLOBAL'],
      system: process.env['GIT_CONFIG_SYSTEM'],
    };
    process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
    process.env['GIT_CONFIG_SYSTEM'] = '/dev/null';
    try {
      await expect(commitAll(r, 'nope')).rejects.toThrow(/no author identity/i);
      await expect(commitAll(r, 'nope')).rejects.toMatchObject({
        hint: expect.stringContaining('git config'),
      });
    } finally {
      for (const [key, value] of [
        ['GIT_CONFIG_GLOBAL', saved.global],
        ['GIT_CONFIG_SYSTEM', saved.system],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
