/**
 * Shared setup for anything that becomes the live orchestrator process in
 * this CLI invocation: `capo run --foreground` (whether typed directly or
 * spawned detached by a plain `capo run`), and `capo resume <run-id>` when
 * no live orchestrator process remains to signal.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Orchestrator,
  StateStore,
  allocateRunId,
  runDir,
} from '@capo/core';
import type { CapoConfig, PlatformId, RunId, RunState } from '@capo/core';
import { buildAdapters } from './adapters.js';
import { makeFileLogger } from './logger.js';
import { writePidFile } from './pid.js';

export interface StartedRun {
  orchestrator: Orchestrator;
  store: StateStore;
  dir: string;
  runId: RunId;
}

/**
 * Allocates a fresh run id, materializes the run directory (`state.json`,
 * `config.resolved.json`, the pid file), and returns a ready-to-`start()`
 * `Orchestrator`. Once `StateStore.create` returns, `state.json` exists on
 * disk — that is the signal the detaching parent process polls for, so it
 * must happen before any slow work (git worktrees, spawning platform
 * sessions).
 */
export async function createRun(config: CapoConfig, startOn: PlatformId | undefined): Promise<StartedRun> {
  const runId = await allocateRunId(config.workspace);
  const dir = runDir(config.workspace, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.resolved.json'), JSON.stringify(config, null, 2), 'utf8');

  const activePlatform = startOn ?? config.startOn;
  const now = new Date().toISOString();
  const initial: RunState = {
    version: 1,
    runId,
    activePlatform,
    status: 'running',
    pauseCount: 0,
    baseCommit: '',
    sessions: {},
    tasks: {},
    limits: {},
    startedAt: now,
    updatedAt: now,
  };

  const store = await StateStore.create(dir, initial);
  await writePidFile(dir);

  const orchestrator = new Orchestrator({
    config,
    runDir: dir,
    state: store,
    adapters: buildAdapters(config.platforms),
    log: makeFileLogger(dir),
  });

  return { orchestrator, store, dir, runId };
}

/** Rebuilds an `Orchestrator` for an existing run directory, from its frozen resolved config. */
export async function reopenRun(dir: string): Promise<{ orchestrator: Orchestrator; config: CapoConfig }> {
  const raw = await readFile(join(dir, 'config.resolved.json'), 'utf8');
  const parsed = JSON.parse(raw) as CapoConfig;
  // `config.resolved.json` is frozen at run-creation time and never
  // rewritten, so a run recorded before a `CapoConfig` field existed has no
  // key for it on disk. Both of these are read as `.length` by the
  // orchestrator (setup and the combined check), so a plain `JSON.parse`
  // leaves them `undefined` and that throws deep inside a resumed run.
  // Default them here; keep whatever the file actually has otherwise.
  const config: CapoConfig = {
    ...parsed,
    setupCommand: parsed.setupCommand ?? [],
    checkCommand: parsed.checkCommand ?? [],
  };
  const store = await StateStore.open(dir);

  const orchestrator = new Orchestrator({
    config,
    runDir: dir,
    state: store,
    adapters: buildAdapters(config.platforms),
    log: makeFileLogger(dir),
  });

  return { orchestrator, config };
}
