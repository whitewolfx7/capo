import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { type GitIdentity, addWorktree, changedPaths, git, identityArgs, removeWorktree } from '../git/repo.js';
import { checkScope } from '../git/scope.js';
import type { TaskId, TaskRecord } from '../types.js';

const execFile = promisify(execFileCb);
const MAX_BUFFER = 16 * 1024 * 1024;

export interface ResultSubmission {
  taskId: TaskId;
  baseCommit: string;
  resultCommit: string;
  evidence: string;
}

export interface AcceptanceOutcome {
  accepted: boolean;
  reason?: string;
  violations: string[];
}

/**
 * Independently checks a submitted result against the task's approved base
 * and write scope. A coordinator's own report never marks a task done: this
 * is the check that stands in its place.
 */
export async function acceptResult(
  repo: string,
  task: TaskRecord,
  sub: ResultSubmission,
  /**
   * The paths this result is allowed to touch. Defaults to the task's own
   * declared scope, which is what a lone task is checked against.
   *
   * A coordinator that owns several tasks does all of them in one worktree,
   * because it is one session with one working directory. Its second result
   * therefore carries its first task's files too, and checking it against
   * one task's scope alone would reject work that never left what the
   * coordinator owns. The boundary that matters -- and the one still
   * enforced here -- is between coordinators: nothing may write into
   * another coordinator's scope.
   */
  allowedScope: string[] = task.writeScope,
): Promise<AcceptanceOutcome> {
  if (sub.baseCommit !== task.baseCommit) {
    return {
      accepted: false,
      reason: `submitted base ${sub.baseCommit} does not match the task's recorded base ${task.baseCommit}`,
      violations: [],
    };
  }

  try {
    await git(repo, ['cat-file', '-e', `${sub.resultCommit}^{commit}`]);
  } catch {
    return { accepted: false, reason: 'result commit not found', violations: [] };
  }

  const paths = await changedPaths(repo, sub.baseCommit, sub.resultCommit);
  const { ok, violations } = checkScope(paths, allowedScope);
  if (!ok) {
    return { accepted: false, reason: 'result writes outside its approved write scope', violations };
  }

  return { accepted: true, violations: [] };
}

export interface IntegrationReport {
  merged: TaskId[];
  conflicted: { taskId: TaskId; files: string[] }[];
  checksPassed: boolean;
  checkOutput: string;
}

/**
 * Merges each accepted task's result commit into a fresh integration
 * worktree, one at a time, in task order. A conflict on one task is recorded
 * and skipped -- it never discards tasks that already merged cleanly. Once
 * every task has been attempted, `checkCommand` runs once against the
 * combined tree.
 */
/** Whether a merge is actually in progress (MERGE_HEAD exists). */
async function inMerge(worktree: string): Promise<boolean> {
  try {
    await git(worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function integrate(opts: {
  repo: string;
  runDir: string;
  baseCommit: string;
  tasks: TaskRecord[];
  submissions: Map<TaskId, ResultSubmission>;
  checkCommand?: string[];
  /** Omit in production so the user's own git identity and signing are used. */
  identity?: GitIdentity;
}): Promise<IntegrationReport> {
  const { repo, runDir, baseCommit, tasks, submissions, checkCommand, identity } = opts;
  const worktree = join(runDir, 'integration');
  const branch = `capo/integration/${basename(runDir)}`;

  // Remove any stale integration worktree first so a re-run is clean.
  await removeWorktree(repo, worktree);
  await addWorktree(repo, worktree, branch, baseCommit);

  const merged: TaskId[] = [];
  const conflicted: { taskId: TaskId; files: string[] }[] = [];

  for (const task of tasks) {
    const sub = submissions.get(task.id);
    if (!sub) continue;

    try {
      // No hardcoded identity: a merge commit lands in the user's own
      // repository, so it uses their git config and their signing settings.
      // Tests pass an identity explicitly via `opts.identity`.
      await git(worktree, [
        ...identityArgs(identity),
        'merge', '--no-ff', '--no-edit', sub.resultCommit,
      ]);
      merged.push(task.id);
    } catch (err) {
      // A failed merge is not automatically a conflict. Git refuses to merge
      // for reasons that have nothing to do with the diffs -- no configured
      // committer identity being the one that actually bit -- and those leave
      // no MERGE_HEAD behind, so the `merge --abort` that used to follow
      // unconditionally threw a second error out of this function and lost
      // every task's outcome with it. Only an in-progress merge is aborted,
      // and only a merge that really conflicted is reported as one.
      const filesOut = await git(worktree, ['diff', '--name-only', '--diff-filter=U']);
      const files = filesOut.length === 0 ? [] : filesOut.split('\n');
      const mid = await inMerge(worktree);
      if (mid) await git(worktree, ['merge', '--abort']);

      if (!mid && files.length === 0) throw err;
      conflicted.push({ taskId: task.id, files });
    }
  }

  let checksPassed = true;
  let checkOutput = '';

  if (checkCommand && checkCommand.length > 0) {
    const [cmd, ...args] = checkCommand as [string, ...string[]];
    try {
      const { stdout, stderr } = await execFile(cmd, args, { cwd: worktree, maxBuffer: MAX_BUFFER });
      checkOutput = `${stdout}${stderr}`;
    } catch (err) {
      checksPassed = false;
      checkOutput = execErrorOutput(err);
    }
  }

  return { merged, conflicted, checksPassed, checkOutput };
}

function execErrorOutput(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (combined.length > 0) return combined;
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}
