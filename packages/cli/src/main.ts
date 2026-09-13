/**
 * The `capo` CLI entry point.
 *
 * `main()` never calls `process.exit` itself: it returns an exit code, so
 * tests can call it directly with a captured `Io` and assert on the
 * return value, instead of spawning a process. The thin wrapper at the
 * bottom of this file is the only place that touches `process.exit`, and
 * only runs when this file is executed directly (not when it's imported).
 */
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Io } from './io.js';
import { runRun } from './commands/run.js';
import { runStatus } from './commands/status.js';
import { runSwitch } from './commands/switch.js';
import { runResume } from './commands/resume.js';
import { runDoctor } from './commands/doctor.js';

export const VERSION = '0.1.0';

const SELF_PATH = fileURLToPath(import.meta.url);

const COMMANDS = ['run', 'status', 'switch', 'resume', 'doctor'] as const;

const HELP_TEXT = `capo ${VERSION} -- run one AI agent team across Claude Code and Codex

Usage:
  capo run --config <path> [--foreground] [--start-on <platform>]
  capo status [<run-id>] [--json] [--workspace <dir>]
  capo switch <run-id> [--to <platform>] [--workspace <dir>]
  capo resume <run-id> [--workspace <dir>]
  capo doctor [--json]
  capo --version
  capo --help

Commands:
  run       start a run from a config file
  status    show which platform, which sessions, and the task table
  switch    force a checkpoint and move a live run to another platform
  resume    continue a run from its latest checkpoint
  doctor    check that this machine can run capo`;

export async function main(argv: string[], io: Io): Promise<number> {
  if (argv.length === 0) {
    io.err(HELP_TEXT);
    return 2;
  }

  const [command, ...rest] = argv;

  if (command === '--help' || command === '-h') {
    io.out(HELP_TEXT);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    io.out(VERSION);
    return 0;
  }

  switch (command) {
    case 'run':
      return dispatchRun(rest, io);
    case 'status':
      return dispatchStatus(rest, io);
    case 'switch':
      return dispatchSwitch(rest, io);
    case 'resume':
      return dispatchResume(rest, io);
    case 'doctor':
      return dispatchDoctor(rest, io);
    default:
      io.err(`Unknown command: ${command}`);
      io.err(`Known commands: ${COMMANDS.join(', ')}.`);
      return 2;
  }
}

function usageError(command: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `capo ${command}: ${detail}`;
}

async function dispatchRun(rest: string[], io: Io): Promise<number> {
  let values: { config?: string; foreground?: boolean; 'start-on'?: string };
  try {
    ({ values } = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        config: { type: 'string' },
        foreground: { type: 'boolean', default: false },
        'start-on': { type: 'string' },
      },
    }));
  } catch (err) {
    io.err(usageError('run', err));
    return 2;
  }

  if (!values.config) {
    io.err('capo run requires --config <path>');
    return 2;
  }

  return runRun(
    { config: values.config, foreground: values.foreground ?? false, startOn: values['start-on'] },
    io,
    SELF_PATH,
  );
}

async function dispatchStatus(rest: string[], io: Io): Promise<number> {
  let values: { json?: boolean; workspace?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        workspace: { type: 'string' },
      },
    }));
  } catch (err) {
    io.err(usageError('status', err));
    return 2;
  }

  return runStatus({ runId: positionals[0], json: values.json ?? false, workspace: values.workspace }, io);
}

async function dispatchSwitch(rest: string[], io: Io): Promise<number> {
  let values: { to?: string; workspace?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { to: { type: 'string' }, workspace: { type: 'string' } },
    }));
  } catch (err) {
    io.err(usageError('switch', err));
    return 2;
  }

  const runId = positionals[0];
  if (!runId) {
    io.err('capo switch requires a <run-id>');
    return 2;
  }

  return runSwitch({ runId, to: values.to, workspace: values.workspace }, io);
}

async function dispatchResume(rest: string[], io: Io): Promise<number> {
  let values: { workspace?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { workspace: { type: 'string' } },
    }));
  } catch (err) {
    io.err(usageError('resume', err));
    return 2;
  }

  const runId = positionals[0];
  if (!runId) {
    io.err('capo resume requires a <run-id>');
    return 2;
  }

  return runResume({ runId, workspace: values.workspace }, io);
}

async function dispatchDoctor(rest: string[], io: Io): Promise<number> {
  let values: { json?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: { json: { type: 'boolean', default: false } },
    }));
  } catch (err) {
    io.err(usageError('doctor', err));
    return 2;
  }

  return runDoctor({ json: values.json ?? false }, io);
}

const realIo: Io = {
  out(s: string): void {
    process.stdout.write(`${s}\n`);
  },
  err(s: string): void {
    process.stderr.write(`${s}\n`);
  },
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2), realIo));
}
