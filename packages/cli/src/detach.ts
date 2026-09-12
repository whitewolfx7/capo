/**
 * The mechanics of starting the orchestrator as a background process that
 * outlives the shell (and the host conversation) that launched it, and of
 * waiting just long enough to know it actually started.
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Spawns `node <selfPath> <args...>` fully detached: its own process group,
 * stdio redirected to `logPath` (never inherited from the parent), and
 * `unref()`d so this process can exit without waiting on it. Returns the
 * child's pid.
 */
export function spawnDetached(selfPath: string, args: string[], logPath: string): number {
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [selfPath, ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error('failed to spawn the detached orchestrator process');
  }
  return child.pid;
}

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 10_000;

/**
 * Polls for `path` to exist, every `intervalMs`, up to `timeoutMs` total.
 * Returns whether it appeared in time. Never throws, never hangs past the
 * cap.
 */
export async function waitForFile(
  path: string,
  intervalMs: number = POLL_INTERVAL_MS,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return true;
    } catch {
      // Not there yet.
    }
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}
