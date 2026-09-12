import { join } from 'node:path';
import type { RunId } from '../types.js';

export function capoDir(workspace: string): string {
  return join(workspace, '.capo');
}

export function runDir(workspace: string, runId: RunId): string {
  return join(capoDir(workspace), 'runs', runId);
}

export function checkpointsDir(workspace: string, runId: RunId): string {
  return join(runDir(workspace, runId), 'checkpoints');
}

export function newRunId(now: Date = new Date(), sequence = 1): RunId {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const seq = String(sequence).padStart(3, '0');
  return `${y}-${m}-${d}-${seq}`;
}
