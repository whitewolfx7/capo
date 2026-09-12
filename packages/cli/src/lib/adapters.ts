/**
 * Turns a config's `platforms` map (each entry naming a `driver`) into the
 * `Map<PlatformId, PlatformAdapter>` the `Orchestrator` needs. The map is
 * keyed by the config's own platform ids (whatever the user called them),
 * not by an adapter's own `.id`, since those are independent: a config can
 * call its Claude Code platform "claude" while the adapter itself always
 * reports `.id === 'claude-code'`.
 */
import { CapoError, ClaudeAdapter, CodexAdapter, FakeAdapter } from '@capo/core';
import type { CapoConfig, PlatformAdapter, PlatformId } from '@capo/core';

export function buildAdapters(platforms: CapoConfig['platforms']): Map<PlatformId, PlatformAdapter> {
  const adapters = new Map<PlatformId, PlatformAdapter>();
  for (const [id, def] of Object.entries(platforms)) {
    adapters.set(id, adapterFor(id, def.driver));
  }
  return adapters;
}

function adapterFor(id: PlatformId, driver: string): PlatformAdapter {
  switch (driver) {
    case 'claude-code':
      return new ClaudeAdapter();
    case 'codex':
      return new CodexAdapter();
    case 'fake':
      // Not reachable from real orchestration: only a config that names it
      // explicitly (e.g. an example or a test fixture) can select it.
      return new FakeAdapter(id);
    default:
      throw new CapoError(
        `Unknown platform driver "${driver}" for platform "${id}"`,
        'Use "claude-code" or "codex" as the driver.',
      );
  }
}
