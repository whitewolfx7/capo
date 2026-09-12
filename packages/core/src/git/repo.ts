import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { CapoError } from '../types.js';

const execFile = promisify(execFileCb);
const MAX_BUFFER = 16 * 1024 * 1024;

/** Runs `git` with an argument array (never a shell) and returns trimmed stdout. */
export async function git(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', args, { cwd: repo, maxBuffer: MAX_BUFFER });
    return stdout.trim();
  } catch (err) {
    const stderr = isExecError(err) ? err.stderr : undefined;
    const detail = typeof stderr === 'string' && stderr.trim().length > 0
      ? stderr.trim()
      : err instanceof Error
        ? err.message
        : String(err);
    throw new CapoError(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function isExecError(err: unknown): err is { stderr?: string } {
  return typeof err === 'object' && err !== null && 'stderr' in err;
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return out === 'true';
  } catch {
    return false;
  }
}

export async function headCommit(repo: string): Promise<string> {
  return git(repo, ['rev-parse', 'HEAD']);
}

export async function isClean(repo: string): Promise<boolean> {
  const out = await git(repo, ['status', '--porcelain']);
  return out.length === 0;
}

export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  await git(repo, ['worktree', 'add', '-b', branch, path, base]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  try {
    await git(repo, ['worktree', 'remove', '--force', path]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('is not a working tree')) {
      // Path may simply not exist as a worktree at all (e.g. already removed).
      // Fall through to prune regardless, but only swallow known "not a worktree" cases
      // or a path that never existed.
      if (!message.includes('No such file or directory') && !message.includes("is not a working tree")) {
        // Re-throw anything unexpected so real failures are still visible.
        if (!(await pathLooksAlreadyGone(message))) {
          throw err;
        }
      }
    }
  }
  await git(repo, ['worktree', 'prune']);
}

async function pathLooksAlreadyGone(message: string): Promise<boolean> {
  return (
    message.includes('is not a working tree') ||
    message.includes('No such file or directory') ||
    message.includes('not a working tree')
  );
}

export async function commitAll(repo: string, message: string): Promise<string | undefined> {
  await git(repo, ['add', '-A']);
  if (await isClean(repo)) return undefined;
  await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  return headCommit(repo);
}

export async function changedPaths(repo: string, base: string, head: string): Promise<string[]> {
  const out = await git(repo, ['diff', '--name-only', '--find-renames', base, head]);
  if (out.length === 0) return [];
  return out.split('\n').map(p => p.replace(/\\/g, '/'));
}
