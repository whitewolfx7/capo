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
  const { ok, violations } = checkScope(paths, task.writeScope);
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
    } catch {
      const filesOut = await git(worktree, ['diff', '--name-only', '--diff-filter=U']);
      const files = filesOut.length === 0 ? [] : filesOut.split('\n');
      await git(worktree, ['merge', '--abort']);
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
