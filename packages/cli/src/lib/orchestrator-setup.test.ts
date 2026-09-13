import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '@capo/core';
import { reopenRun } from './orchestrator-setup.js';

/**
 * `config.resolved.json` is frozen at run-creation time and never rewritten.
 * A run recorded before `setupCommand`/`checkCommand` existed in `CapoConfig`
 * has neither key on disk. `reopenRun` must default them so older runs can
 * still resume through integration instead of throwing when
 * `Orchestrator` reads `.setupCommand.length` / `.checkCommand.length`.
 */
describe('reopenRun', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'capo-reopen-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults setupCommand and checkCommand when an older config.resolved.json lacks them', async () => {
    const legacyConfig = {
      version: 1,
      configPath: '/tmp/orchestration.yaml',
      workspace: dir,
      objective: '/tmp/objective.md',
      platforms: { claude: { driver: 'fake' }, codex: { driver: 'fake' } },
      startOn: 'claude',
      models: {},
      roles: {},
      context: [],
      coordinators: [],
      tasks: [],
      limits: { maxWorkersPerCoordinator: 1 },
      transcripts: true,
      stallTimeoutMs: 60000,
      autonomy: 'autonomous',
      // Deliberately missing: setupCommand, checkCommand.
    };
    await writeFile(join(dir, 'config.resolved.json'), JSON.stringify(legacyConfig, null, 2), 'utf8');

    const state: RunState = {
      version: 1,
      runId: '2026-01-01-001',
      activePlatform: 'claude',
      status: 'running',
      pauseCount: 0,
      baseCommit: 'deadbeef',
      sessions: {},
      tasks: {},
      limits: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

    const { config } = await reopenRun(dir);

    expect(config.setupCommand).toEqual([]);
    expect(config.checkCommand).toEqual([]);
  });

  it('keeps setupCommand and checkCommand when present in config.resolved.json', async () => {
    const config = {
      version: 1,
      configPath: '/tmp/orchestration.yaml',
      workspace: dir,
      objective: '/tmp/objective.md',
      platforms: { claude: { driver: 'fake' }, codex: { driver: 'fake' } },
      startOn: 'claude',
      models: {},
      roles: {},
      context: [],
      coordinators: [],
      tasks: [],
      limits: { maxWorkersPerCoordinator: 1 },
      transcripts: true,
      stallTimeoutMs: 60000,
      autonomy: 'autonomous',
      setupCommand: ['npm', 'ci'],
      checkCommand: ['npm', 'test'],
    };
    await writeFile(join(dir, 'config.resolved.json'), JSON.stringify(config, null, 2), 'utf8');

    const state: RunState = {
      version: 1,
      runId: '2026-01-01-001',
      activePlatform: 'claude',
      status: 'running',
      pauseCount: 0,
      baseCommit: 'deadbeef',
      sessions: {},
      tasks: {},
      limits: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

    const { config: reopened } = await reopenRun(dir);

    expect(reopened.setupCommand).toEqual(['npm', 'ci']);
    expect(reopened.checkCommand).toEqual(['npm', 'test']);
  });
});
