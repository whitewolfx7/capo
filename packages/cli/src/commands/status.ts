/**
 * `capo status [<run-id>] [--json] [--workspace <dir>]`
 *
 * Reads `state.json` for one run (the latest under the workspace, unless a
 * run id is given) and prints either a human-readable summary or, with
 * `--json`, a document a script can parse.
 *
 * It also checks whether the orchestrator process is actually alive. state.json
 * records what the run was doing, not whether anyone is still doing it: a
 * killed or crashed orchestrator leaves a file that still says "running" with
 * every session "running". Reporting that as healthy is worse than useless,
 * because the user's next move depends on knowing to resume.
 */
import { resolve } from 'node:path';
import { readState, runDir } from '@capo/core';
import type { RunState } from '@capo/core';
import type { Io } from '../io.js';
import { reportError } from '../lib/errors.js';
import { isPidAlive, readPidFile } from '../lib/pid.js';
import { latestRunId } from '../lib/run-locate.js';

export interface StatusOpts {
  runId?: string;
  json: boolean;
  workspace?: string;
}

export async function runStatus(opts: StatusOpts, io: Io): Promise<number> {
  const workspace = opts.workspace !== undefined ? resolve(opts.workspace) : process.cwd();

  try {
    const runId = opts.runId ?? (await latestRunId(workspace));
    const dir = runDir(workspace, runId);
    const state = await readState(dir);

    const pid = await readPidFile(dir);
    const live = pid !== undefined && isPidAlive(pid);

    io.out(
      opts.json
        ? JSON.stringify({ ...toJsonDoc(state), orchestratorPid: pid ?? null, live }, null, 2)
        : renderHuman(state, live, runId),
    );
    return 0;
  } catch (err) {
    return reportError(err, io);
  }
}

function toJsonDoc(state: RunState): Record<string, unknown> {
  return {
    runId: state.runId,
    activePlatform: state.activePlatform,
    status: state.status,
    pauseCount: state.pauseCount,
    baseCommit: state.baseCommit,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    sessions: state.sessions,
    limits: state.limits,
    // The task table: one row per configured task, in `state.tasks`'
    // insertion order. Exposed under both names since "the task table" is
    // the natural reading and `tasks` mirrors `RunState` itself.
    taskTable: Object.values(state.tasks),
    tasks: state.tasks,
  };
}

function renderHuman(state: RunState, live: boolean, runId: string): string {
  const lines: string[] = [];
  lines.push(`run ${state.runId}  [${state.status}]  active platform: ${state.activePlatform}`);
  if (!live && state.status !== 'done' && state.status !== 'failed') {
    lines.push(
      `WARNING: no live orchestrator process. The state below is the last thing`,
    );
    lines.push(`         it wrote, not what is happening now.`);
    lines.push(`         Continue it with: capo resume ${runId}`);
  }
  lines.push(`base commit: ${state.baseCommit || '(not yet set)'}   pauses: ${state.pauseCount}`);
  lines.push('');

  lines.push('sessions:');
  const sessions = Object.values(state.sessions);
  if (sessions.length === 0) {
    lines.push('  (none yet)');
  } else {
    for (const s of sessions) {
      const sid = s.platformSessionId !== undefined ? `  session-id=${s.platformSessionId}` : '';
      lines.push(`  ${s.id}  role=${s.role}  platform=${s.platform}  status=${s.status}${sid}`);
    }
  }
  lines.push('');

  lines.push('tasks:');
  const tasks = Object.values(state.tasks);
  if (tasks.length === 0) {
    lines.push('  (none)');
  } else {
    for (const t of tasks) {
      const note = t.note ? `  note=${t.note}` : '';
      lines.push(`  ${t.id}  coordinator=${t.coordinator}  state=${t.state}${note}`);
    }
  }

  return lines.join('\n');
}
