/**
 * `capo run --config <path> [--foreground] [--start-on <platform>]`
 *
 * Without `--foreground`, this process validates the config, spawns a
 * detached copy of itself running `run --foreground`, waits for that
 * copy's `state.json` to appear, prints the run id, and exits — the
 * orchestrator keeps running after this process (and the shell, and the
 * host conversation that invoked it) is gone.
 *
 * With `--foreground`, this process *becomes* the orchestrator: it starts
 * every session, prints the run id as its first line of output, and then
 * blocks, handling `SIGUSR2` (switch/resume requests) and `SIGINT`/
 * `SIGTERM` (clean shutdown) until asked to stop.
 */
import { mkdir as mkdirFs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { allocateRunId, loadConfig, runDir, capoDir } from '@capo/core';
import type { CapoConfig } from '@capo/core';
import type { Io } from '../io.js';
import { reportError } from '../lib/errors.js';
import { createRun } from '../lib/orchestrator-setup.js';
import { blockUntilStopped } from '../lib/signals.js';
import { spawnDetached, waitForFile } from '../detach.js';

export interface RunOpts {
  config: string;
  foreground: boolean;
  startOn?: string;
}

export async function runRun(opts: RunOpts, io: Io, selfPath: string): Promise<number> {
  let config: CapoConfig;
  try {
    config = await loadConfig(opts.config);
  } catch (err) {
    return reportError(err, io);
  }

  if (opts.startOn !== undefined && !(opts.startOn in config.platforms)) {
    io.err(`--start-on names an undeclared platform: ${opts.startOn}`);
    io.err(`Declared platforms: ${Object.keys(config.platforms).join(', ')}.`);
    return 1;
  }

  return opts.foreground
    ? runForeground(config, opts.startOn, io)
    : runDetached(config, opts, io, selfPath);
}

async function runForeground(config: CapoConfig, startOn: string | undefined, io: Io): Promise<number> {
  try {
    const { orchestrator, dir, runId } = await createRun(config, startOn);
    io.out(runId);

    const stopped = blockUntilStopped(orchestrator, dir, (line) => io.err(line));
    await orchestrator.start();
    await stopped;
    return 0;
  } catch (err) {
    return reportError(err, io);
  }
}

async function runDetached(config: CapoConfig, opts: RunOpts, io: Io, selfPath: string): Promise<number> {
  try {
    // Read-only prediction: the child performs this exact same computation
    // once it creates the run directory, so as long as nothing else creates
    // a run under this workspace between now and then, the ids match.
    const predictedRunId = await allocateRunId(config.workspace);
    const dir = runDir(config.workspace, predictedRunId);

    const logDir = join(capoDir(config.workspace), 'logs');
    await mkdirFs(logDir, { recursive: true });
    const logPath = join(logDir, `${predictedRunId}.log`);

    const args = ['run', '--config', resolve(opts.config), '--foreground'];
    if (opts.startOn !== undefined) args.push('--start-on', opts.startOn);
    spawnDetached(selfPath, args, logPath);

    const found = await waitForFile(join(dir, 'state.json'));
    if (!found) {
      io.err(`the orchestrator did not start within 10s (no state.json under ${dir})`);
      io.err(`check its log: ${logPath}`);
      return 1;
    }

    io.out(predictedRunId);
    return 0;
  } catch (err) {
    return reportError(err, io);
  }
}
