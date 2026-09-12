/**
 * Wires up the two signals a live orchestrator process responds to:
 *   - SIGUSR2: a `switch`/`resume` request is waiting in `control.json`.
 *   - SIGINT/SIGTERM: shut down cleanly (checkpoint, close sessions).
 * Returns a promise that resolves once the process has been asked to stop
 * and has finished stopping — that is what `run --foreground` and
 * `resume` block on.
 */
import { readFile } from 'node:fs/promises';
import type { Orchestrator } from '@capo/core';
import { controlFilePath, type ControlRequest } from './control.js';
import { clearPidFile } from './pid.js';

export function blockUntilStopped(orchestrator: Orchestrator, dir: string, log: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    // Hold the event loop open for the life of the run.
    //
    // An unresolved promise does not keep Node running, and neither do the
    // signal listeners below. Without this the orchestrator exits the moment
    // nothing else is pending, and Node prints "Detected unsettled top-level
    // await" on the way out. That is not hypothetical: a Codex session runs
    // one child process per turn, so between turns there may be no open
    // handle at all, and the run would die silently mid-flight leaving a
    // state.json that still says "running".
    const keepAlive = setInterval(() => {}, 1 << 30);

    const onControlSignal = (): void => {
      void handleControlSignal(orchestrator, dir, log);
    };

    let stopping = false;
    const onStopSignal = (): void => {
      if (stopping) return;
      stopping = true;
      process.off('SIGUSR2', onControlSignal);
      process.off('SIGINT', onStopSignal);
      process.off('SIGTERM', onStopSignal);
      orchestrator
        .stop()
        .catch((err) => log(`stop error: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          clearInterval(keepAlive);
          void clearPidFile(dir).finally(resolve);
        });
    };

    process.on('SIGUSR2', onControlSignal);
    process.on('SIGINT', onStopSignal);
    process.on('SIGTERM', onStopSignal);
  });
}

async function handleControlSignal(orchestrator: Orchestrator, dir: string, log: (line: string) => void): Promise<void> {
  let req: ControlRequest;
  try {
    const raw = await readFile(controlFilePath(dir), 'utf8');
    req = JSON.parse(raw) as ControlRequest;
  } catch (err) {
    log(`control signal received but control.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    if (req.action === 'stop') {
      await orchestrator.stop();
    } else if (req.action === 'resume') {
      // A live process only needs resuming when it parked itself because
      // every platform was capped. Routing this through requestSwitch would
      // do nothing there: with no live sessions it checkpoints nothing, and
      // it would pick the same capped platforms and park again. resume()
      // relaunches from the checkpoints on disk and clears limits that have
      // expired.
      const index = await orchestrator.resume();
      log(
        index === undefined
          ? 'resumed; no checkpoint set found, launched clean'
          : `resumed from checkpoint set ${String(index).padStart(3, '0')}`,
      );
    } else {
      await orchestrator.requestSwitch(req.to, 'user-switch');
    }
  } catch (err) {
    log(`control request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
