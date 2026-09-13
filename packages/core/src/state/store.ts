import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { CapoError } from '../types.js';
import type { RunId, RunState } from '../types.js';
import { capoDir, checkpointsDir, newRunId, runDir } from './paths.js';

export { capoDir, checkpointsDir, newRunId, runDir };

const STATE_FILE = 'state.json';

let tmpCounter = 0;

/**
 * Scans `<workspace>/.capo/runs` for today's runs (per `now`) and returns the
 * next free sequence id, e.g. `2026-09-12-001`, `2026-09-12-002`, ...
 */
export async function allocateRunId(workspace: string, now: Date = new Date()): Promise<RunId> {
  const runsDir = join(capoDir(workspace), 'runs');
  const prefix = newRunId(now, 1).slice(0, -3); // 'YYYY-MM-DD-'

  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return newRunId(now, 1);
    }
    throw err;
  }

  let max = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(prefix.length);
    if (!/^\d{3}$/.test(suffix)) continue;
    const n = Number(suffix);
    if (n > max) max = n;
  }

  return newRunId(now, max + 1);
}

/** One-shot read for clients that must not take ownership of the run. */
export async function readState(dir: string): Promise<RunState> {
  let raw: string;
  try {
    raw = await readFile(join(dir, STATE_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CapoError(`no run found at ${dir}`, 'check the run id with: capo status');
    }
    throw err;
  }
  return JSON.parse(raw) as RunState;
}

export class StateStore {
  #state: RunState;
  #queue: Promise<unknown> = Promise.resolve();
  readonly dir: string;

  private constructor(dir: string, state: RunState) {
    this.dir = dir;
    this.#state = state;
  }

  static async create(dir: string, initial: RunState): Promise<StateStore> {
    await mkdir(dir, { recursive: true });
    const store = new StateStore(dir, structuredClone(initial));
    await store.#write(store.#state);
    return store;
  }

  static async open(dir: string): Promise<StateStore> {
    const state = await readState(dir);
    return new StateStore(dir, state);
  }

  get(): RunState {
    return structuredClone(this.#state);
  }

  async update(fn: (draft: RunState) => void): Promise<RunState> {
    const run = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      fn(draft);
      draft.updatedAt = new Date().toISOString();
      await this.#write(draft);
      this.#state = draft;
      return structuredClone(draft);
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Resolves once every update queued so far has been written to disk.
   * Teardown awaits this before clearing the pid file: without it, a
   * process that exits right after its last `update()` call races its own
   * write, leaving a `state.json.<pid>.<n>.tmp` behind forever.
   */
  async flush(): Promise<void> {
    await this.#queue;
  }

  async #write(state: RunState): Promise<void> {
    const target = join(this.dir, STATE_FILE);
    const tmp = join(this.dir, `${STATE_FILE}.${process.pid}.${tmpCounter++}.tmp`);
    const json = JSON.stringify(state, null, 2);

    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  }
}
