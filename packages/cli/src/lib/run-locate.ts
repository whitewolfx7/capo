/**
 * `capo status` (with no run id) and, in principle, any command that wants
 * "the run I most recently started" resolve that by listing
 * `<workspace>/.capo/runs` and taking the lexicographically last entry:
 * run ids are `YYYY-MM-DD-NNN`, so lexicographic order is chronological
 * order.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CapoError, capoDir } from '@capo/core';
import type { RunId } from '@capo/core';

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{3}$/;

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
