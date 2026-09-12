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

/** Swallowed: the path is already gone, so there is nothing left to remove. */
const ALREADY_GONE = [/is not a working tree/, /No such file or directory/];

export async function removeWorktree(repo: string, path: string): Promise<void> {
  try {
    await git(repo, ['worktree', 'remove', '--force', path]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!ALREADY_GONE.some(re => re.test(message))) throw err;
  }
  await git(repo, ['worktree', 'prune']);
}

/**
 * A git author identity. Tests pass one so they do not depend on the
 * developer's global config; production passes nothing.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Builds the `-c` flags for a commit.
 *
 * With no identity, this returns nothing and git uses the user's OWN config.
 * That is deliberate: CAPO commits into a real repository the user owns, and
 * stamping its own name on their history, or silently turning off commit
 * signing for someone who requires it, would be a surprise they never asked
 * for.
 */
export function identityArgs(identity?: GitIdentity): string[] {
  if (!identity) return [];
  return [
    '-c', `user.email=${identity.email}`,
    '-c', `user.name=${identity.name}`,
    '-c', 'commit.gpgsign=false',
  ];
}

/** Git's complaint when it has no identity configured anywhere. */
const NO_IDENTITY = /Please tell me who you are|unable to auto-detect email address|empty ident name/i;

/**
 * Throws unless git can name a committer in `repo`.
 *
 * Called before a run starts, because every way CAPO has of failing this
 * check later is expensive: the identity is not needed until integration,
 * which is after every coordinator has finished its work. A CI machine with
 * no configured identity reached exactly that point -- all the model work
 * done, nothing integrated -- and the only visible symptom was tasks stuck
 * in `review`.
 */
export async function assertAuthorIdentity(repo: string): Promise<void> {
  try {
    await git(repo, ['var', 'GIT_COMMITTER_IDENT']);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (NO_IDENTITY.test(detail)) {
      throw new CapoError(
        `git has no author identity configured in ${repo}`,
        'set one with: git config --global user.email "you@example.com" && git config --global user.name "Your Name"',
      );
    }
    throw err;
  }
}

/**
 * Stages everything and commits. Returns the new sha, or undefined when there
 * was nothing to commit.
 *
 * @param identity optional; omit it in production so the user's own git
 *                 identity and signing configuration are used.
 */
export async function commitAll(
  repo: string,
  message: string,
  identity?: GitIdentity,
): Promise<string | undefined> {
  await git(repo, ['add', '-A']);
  if (await isClean(repo)) return undefined;
  try {
    await git(repo, [...identityArgs(identity), 'commit', '-m', message]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (NO_IDENTITY.test(detail)) {
      throw new CapoError(
        `git has no author identity configured in ${repo}`,
        'set one with: git config --global user.email "you@example.com" && git config --global user.name "Your Name"',
      );
    }
    throw err;
  }
  return headCommit(repo);
}

export async function changedPaths(repo: string, base: string, head: string): Promise<string[]> {
  const out = await git(repo, ['diff', '--name-only', '--find-renames', base, head]);
  if (out.length === 0) return [];
  return out.split('\n').map(p => p.replace(/\\/g, '/'));
}
