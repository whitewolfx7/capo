/**
 * `capo status` (with no run id) and, in principle, any command that wants
 * "the run I most recently started" resolve that by listing
 * `<workspace>/.capo/runs` and taking the lexicographically last entry:
 * run ids are `YYYY-MM-DD-NNN`, so lexicographic order is chronological
 * order.
 */
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CapoError, capoDir } from '@capo/core';
import type { RunId } from '@capo/core';

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{3}$/;

/**
 * Walks up from `start` to the first directory that holds `.capo/runs/<runId>`
 * (or any `.capo/runs` when no id is given). `capo run` resolves the
 * workspace from the config file, so the shell that later types `capo switch`
 * is often somewhere else -- a monorepo root, an editor's cwd, a plugin's
 * conversation. Making the person guess the right directory is a bug.
 */
export async function locateWorkspace(start: string, runId?: string): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    const probe = runId ? join(capoDir(dir), 'runs', runId) : join(capoDir(dir), 'runs');
    try {
      await stat(probe);
      return dir;
    } catch {
      /* keep climbing */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CapoError(
    runId ? `no run ${runId} found at or above ${resolve(start)}` : `no run found at or above ${resolve(start)}`,
    'pass --workspace <dir>, or run this from inside the project the run was started in',
  );
}

export async function latestRunId(workspace: string): Promise<RunId> {
  const runsDir = join(capoDir(workspace), 'runs');

  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw noRunFound(workspace);
    }
    throw err;
  }

  const runIds = entries.filter((e) => RUN_ID_RE.test(e)).sort();
  const last = runIds[runIds.length - 1];
  if (last === undefined) throw noRunFound(workspace);
  return last;
}

function noRunFound(workspace: string): CapoError {
  return new CapoError(
    `no run found in ${workspace}`,
    'start one with: capo run --config <path>',
  );
}
