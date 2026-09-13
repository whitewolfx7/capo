/**
 * `capo resume <run-id> [--workspace <dir>]`
 *
 * If the run's orchestrator process is still alive, this behaves like
 * `capo switch` with no explicit target: write `control.json`, signal
 * `SIGUSR2`, let the live process act on it.
 *
 * If it is not alive, there is nothing to signal, so this process becomes
 * the orchestrator itself, in-process: it reopens the run's frozen config
 * and existing `state.json`, and relaunches every session on the run's
 * active platform FROM THE LATEST CHECKPOINT SET ON DISK. That last part is
 * the point of the command: the checkpoints are the only record of what each
 * session had done, and relaunching without them would discard exactly the
 * work they were written to preserve. It then blocks like `run --foreground`.
 */
import { resolve } from 'node:path';
import { readState, runDir } from '@capo/core';
import type { Io } from '../io.js';
import { writeControlRequest } from '../lib/control.js';
import { reportError } from '../lib/errors.js';
import { reopenRun } from '../lib/orchestrator-setup.js';
import { isPidAlive, readPidFile, writePidFile } from '../lib/pid.js';
import { locateWorkspace } from '../lib/run-locate.js';
import { blockUntilStopped } from '../lib/signals.js';

export interface ResumeOpts {
  runId: string;
  workspace?: string;
}

export async function runResume(opts: ResumeOpts, io: Io): Promise<number> {
  let dir: string;

  try {
    const workspace =
      opts.workspace !== undefined ? resolve(opts.workspace) : await locateWorkspace(process.cwd(), opts.runId);
    dir = runDir(workspace, opts.runId);
    await readState(dir);
  } catch (err) {
    return reportError(err, io);
  }

  const pid = await readPidFile(dir);
  if (pid !== undefined && isPidAlive(pid)) {
    await writeControlRequest(dir, { action: 'resume', requestedAt: new Date().toISOString() });
    process.kill(pid, 'SIGUSR2');
    io.out(`resume requested for run ${opts.runId}`);
    return 0;
  }

  try {
    const { orchestrator } = await reopenRun(dir);
    await writePidFile(dir);
    io.out(opts.runId);

    const stopped = blockUntilStopped(orchestrator, dir, (line) => io.err(line));
    // The previous process is gone, so there are no live sessions to
    // checkpoint. resume() reads the last set off disk and gives each session
    // its own, relaunching on the platform the run was left on.
    const index = await orchestrator.resume();
    io.err(
      index === undefined
        ? 'no checkpoint set found; launched clean'
        : `resumed from checkpoint set ${String(index).padStart(3, '0')}`,
    );
    await stopped;
    return 0;
  } catch (err) {
    return reportError(err, io);
  }
}
