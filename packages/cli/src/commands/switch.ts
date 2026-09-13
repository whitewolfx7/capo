/**
 * `capo switch <run-id> [--to <platform>] [--workspace <dir>]`
 *
 * A live orchestrator is required: this only signals one, it never starts
 * one. Writes the request to `control.json` then sends `SIGUSR2` to the
 * recorded pid; the orchestrator's own signal handler (installed in
 * `commands/run.ts`) does the actual switch.
 *
 * A run that already finished has nothing left to switch: there is no live
 * orchestrator to signal, and treating it like a stalled run ("resume it
 * instead") would send the person chasing a process that was never coming
 * back.
 */
import { resolve } from 'node:path';
import { readState, runDir } from '@capo/core';
import type { RunState } from '@capo/core';
import type { Io } from '../io.js';
import { writeControlRequest } from '../lib/control.js';
import { reportError } from '../lib/errors.js';
import { isPidAlive, readPidFile } from '../lib/pid.js';
import { locateWorkspace } from '../lib/run-locate.js';

export interface SwitchOpts {
  runId: string;
  to?: string;
  workspace?: string;
}

export async function runSwitch(opts: SwitchOpts, io: Io): Promise<number> {
  let dir: string;
  let state: RunState;

  try {
    const workspace =
      opts.workspace !== undefined ? resolve(opts.workspace) : await locateWorkspace(process.cwd(), opts.runId);
    dir = runDir(workspace, opts.runId);
    state = await readState(dir);
  } catch (err) {
    return reportError(err, io);
  }

  if (state.status === 'done' || state.status === 'failed') {
    io.err(`run ${opts.runId} is already ${state.status}; nothing to switch`);
    return 1;
  }

  const pid = await readPidFile(dir);
  if (pid === undefined || !isPidAlive(pid)) {
    io.err(`no live orchestrator process for run ${opts.runId}`);
    io.err(`resume it instead with: capo resume ${opts.runId}`);
    return 1;
  }

  await writeControlRequest(dir, {
    action: 'switch',
    to: opts.to,
    requestedAt: new Date().toISOString(),
  });
  process.kill(pid, 'SIGUSR2');

  io.out(`switch requested for run ${opts.runId}${opts.to ? ` -> ${opts.to}` : ''}`);
  return 0;
}
