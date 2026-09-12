/**
 * `capo switch <run-id> [--to <platform>]`
 *
 * A live orchestrator is required: this only signals one, it never starts
 * one. Writes the request to `control.json` then sends `SIGUSR2` to the
 * recorded pid; the orchestrator's own signal handler (installed in
 * `commands/run.ts`) does the actual switch.
 */
import { readState, runDir } from '@capo/core';
import type { Io } from '../io.js';
import { writeControlRequest } from '../lib/control.js';
import { reportError } from '../lib/errors.js';
import { isPidAlive, readPidFile } from '../lib/pid.js';

export interface SwitchOpts {
  runId: string;
  to?: string;
}

export async function runSwitch(opts: SwitchOpts, io: Io): Promise<number> {
  const workspace = process.cwd();
  const dir = runDir(workspace, opts.runId);

  try {
    await readState(dir);
  } catch (err) {
    return reportError(err, io);
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
