/**
 * `state.json` (owned by `@capo/core`) has no place for the orchestrator
 * process's own pid, so the CLI tracks it itself: one small file per run
 * directory, written by the process that becomes the orchestrator and read
 * by `capo status`/`switch`/`resume` to decide whether that process is
 * still alive.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PID_FILE = 'orchestrator.pid';

export function pidFilePath(dir: string): string {
  return join(dir, PID_FILE);
}

export async function writePidFile(dir: string, pid: number = process.pid): Promise<void> {
  await writeFile(pidFilePath(dir), String(pid), 'utf8');
}

export async function readPidFile(dir: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(pidFilePath(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(pid) ? pid : undefined;
}

export async function clearPidFile(dir: string): Promise<void> {
  await rm(pidFilePath(dir), { force: true });
}

/** `process.kill(pid, 0)` sends no signal; it only probes whether `pid` exists. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
