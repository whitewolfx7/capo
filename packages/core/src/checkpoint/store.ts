import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CapoError } from '../types.js';
import type { CheckpointSet, PauseReason, PlatformId } from '../types.js';
import { renderCheckpoint, parseCheckpoint } from './render.js';

const INDEX_FILE = 'INDEX.md';

function pad(index: number): string {
  return String(index).padStart(3, '0');
}

function checkpointsDir(runDir: string): string {
  return join(runDir, 'checkpoints');
}

function setDirFor(runDir: string, index: number): string {
  return join(checkpointsDir(runDir), pad(index));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function renderIndex(set: CheckpointSet): string {
  const lines: string[] = [];
  lines.push(`# Checkpoint set ${pad(set.index)}`);
  lines.push(`reason: ${set.reason}`);
  lines.push(`platform: ${set.platform}`);
  lines.push(`written: ${set.written}`);
  lines.push('');
  lines.push('## Sessions');
  for (const cp of set.checkpoints) {
    lines.push(`- ${cp.sessionId}.md`);
  }
  return lines.join('\n');
}

function parseIndex(markdown: string): { reason: PauseReason; platform: PlatformId; written: string } {
  const header: Record<string, string> = {};
  for (const line of markdown.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'reason' || key === 'platform' || key === 'written') {
      header[key] = value;
    }
  }
  return {
    reason: (header['reason'] ?? '') as PauseReason,
    platform: (header['platform'] ?? '') as PlatformId,
    written: header['written'] ?? '',
  };
}

/**
 * Write a numbered checkpoint set: one Markdown file per session plus an
 * INDEX.md, under `checkpoints/<index padded to 3>/`. Never overwrites an
 * existing set.
 */
export async function writeCheckpointSet(runDir: string, set: CheckpointSet): Promise<string> {
  await mkdir(checkpointsDir(runDir), { recursive: true });
  const dir = setDirFor(runDir, set.index);

  if (await exists(dir)) {
    throw new CapoError(`checkpoint set ${pad(set.index)} already exists`);
  }
  await mkdir(dir, { recursive: false });

  for (const cp of set.checkpoints) {
    await writeFile(join(dir, `${cp.sessionId}.md`), renderCheckpoint(cp), 'utf8');
  }
  await writeFile(join(dir, INDEX_FILE), renderIndex(set), 'utf8');

  return dir;
}

/** Read back a numbered checkpoint set by index. */
export async function readCheckpointSet(runDir: string, index: number): Promise<CheckpointSet> {
  const dir = setDirFor(runDir, index);
  const indexMd = await readFile(join(dir, INDEX_FILE), 'utf8');
  const { reason, platform, written } = parseIndex(indexMd);

  const entries = await readdir(dir);
  const checkpointFiles = entries.filter((name) => name !== INDEX_FILE && name.endsWith('.md'));

  const checkpoints = await Promise.all(
    checkpointFiles.map(async (name) => parseCheckpoint(await readFile(join(dir, name), 'utf8'))),
  );

  return { index, reason, platform, written, checkpoints };
}

/** Find the checkpoint set with the highest numeric index, or undefined if none exist. */
export async function latestCheckpointSet(runDir: string): Promise<CheckpointSet | undefined> {
  let entries;
  try {
    entries = await readdir(checkpointsDir(runDir), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }

  const indices = entries
    .filter((e) => e.isDirectory() && /^\d{3}$/.test(e.name))
    .map((e) => Number.parseInt(e.name, 10));

  if (indices.length === 0) return undefined;

  const max = Math.max(...indices);
  return readCheckpointSet(runDir, max);
}
