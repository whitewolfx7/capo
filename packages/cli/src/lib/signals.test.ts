import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Orchestrator } from '@capo/core';
import { blockUntilStopped } from './signals.js';

/**
 * Enough of an Orchestrator for `blockUntilStopped`: the event emitter it
 * listens on, and a `stop()` that records whether it was called. The real
 * class needs a config, a state store and live adapters to construct, none
 * of which this function touches.
 */
function fakeOrchestrator(): { orch: Orchestrator; stopped: () => boolean } {
  const events = new EventEmitter();
  let didStop = false;
  const orch = {
    events,
    stop: async () => {
      didStop = true;
    },
    flush: async () => {},
  } as unknown as Orchestrator;
  return { orch, stopped: () => didStop };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'capo-signals-'));
  await writeFile(join(dir, 'orchestrator.pid'), String(process.pid));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Fails the test rather than hanging the suite if the promise never settles. */
function withDeadline<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('blockUntilStopped never resolved')), ms).unref(),
    ),
  ]);
}

describe('blockUntilStopped', () => {
  // A run that integrates is over: every task is resolved and every session
  // is closed. Before this, the keepalive interval held the process open
  // anyway, so a finished run sat there until someone pressed Ctrl-C.
  it('resolves when the run integrates, without waiting for a signal', async () => {
    const { orch } = fakeOrchestrator();
    const lines: string[] = [];
    const done = blockUntilStopped(orch, dir, (l) => lines.push(l));

    orch.events.emit('integration-finished', { status: 'done', merged: ['t1'] });

    await withDeadline(done);
    expect(lines).toContain('run done');
  });

  it('does not call stop() on the way out, which would relabel a failed run as done', async () => {
    const { orch, stopped } = fakeOrchestrator();
    const lines: string[] = [];
    const done = blockUntilStopped(orch, dir, (l) => lines.push(l));

    orch.events.emit('integration-finished', { status: 'failed', merged: [] });

    await withDeadline(done);
    expect(stopped()).toBe(false);
    expect(lines).toContain('run failed');
  });

  it('clears the pid file so a finished run is not reported as live', async () => {
    const { orch } = fakeOrchestrator();
    const done = blockUntilStopped(orch, dir, () => {});

    orch.events.emit('integration-finished', { status: 'done', merged: [] });

    await withDeadline(done);
    await expect(readFile(join(dir, 'orchestrator.pid'), 'utf8')).rejects.toThrow();
  });
});
