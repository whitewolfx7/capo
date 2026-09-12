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

    /** Drop every handle and listener holding this process open, then resolve. */
    const teardown = (): void => {
      process.off('SIGUSR2', onControlSignal);
      process.off('SIGINT', onStopSignal);
      process.off('SIGTERM', onStopSignal);
      orchestrator.events.off('integration-finished', onIntegrationFinished);
      orchestrator.events.off('abandoned', onAbandoned);
      clearInterval(keepAlive);
      void clearPidFile(dir).finally(resolve);
    };

    const onStopSignal = (): void => {
      if (stopping) return;
      stopping = true;
      orchestrator
        .stop()
        .catch((err) => log(`stop error: ${err instanceof Error ? err.message : String(err)}`))
        .finally(teardown);
    };

    // A run that integrates has finished on its own: every task is resolved
    // and every session is already closed. Without this the keepalive above
    // holds a finished run open forever, and the only way out is Ctrl-C.
    //
    // Deliberately not routed through `orchestrator.stop()`: the run's final
    // status is already written, and `stop()` unconditionally sets it to
    // "done" -- which would quietly relabel a failed integration as a
    // success on the way out.
    const onIntegrationFinished = (report: { status: string }): void => {
      if (stopping) return;
      stopping = true;
      log(`run ${report.status}`);
      teardown();
    };

    // Every session is gone with the run unfinished: no result can arrive and
    // no integration can fire, so there is nothing left to wait for. Exits
    // non-zero, unlike a run that merely integrated to a `failed` status --
    // this one never got far enough to produce a result at all.
    const onAbandoned = (report: { reason: string }): void => {
      if (stopping) return;
      stopping = true;
      log(`run abandoned: ${report.reason}`);
      process.exitCode = 1;
      teardown();
    };

    process.on('SIGUSR2', onControlSignal);
    process.on('SIGINT', onStopSignal);
    process.on('SIGTERM', onStopSignal);
    orchestrator.events.once('integration-finished', onIntegrationFinished);
    orchestrator.events.once('abandoned', onAbandoned);
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
