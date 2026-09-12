/**
 * The request file `capo switch`/`capo resume` drop next to a live run's
 * `state.json` before signalling its orchestrator process with `SIGUSR2`.
 * The orchestrator's own signal handler (installed in `commands/run.ts`)
 * reads this file back and acts on it.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlatformId } from '@capo/core';

const CONTROL_FILE = 'control.json';

export interface ControlRequest {
  action: 'switch' | 'resume' | 'stop';
  to?: PlatformId;
  requestedAt: string;
}

export function controlFilePath(dir: string): string {
  return join(dir, CONTROL_FILE);
}

export async function writeControlRequest(dir: string, req: ControlRequest): Promise<void> {
  await writeFile(controlFilePath(dir), JSON.stringify(req, null, 2), 'utf8');
}
