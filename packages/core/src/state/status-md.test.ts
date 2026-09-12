import { describe, expect, it } from 'vitest';
import { renderStatusMarkdown } from './status-md.js';
import type { RunState } from '../types.js';

const state = (over: Partial<RunState> = {}): RunState => ({
  version: 1,
  runId: '2026-09-12-001',
  activePlatform: 'claude',
  status: 'running',
  pauseCount: 0,
  baseCommit: 'abc123',
  sessions: {
    root: { id: 'root', role: 'root', platform: 'claude', status: 'running',
            platformSessionId: 'uuid-root' },
    'team-a': { id: 'team-a', role: 'coordinator', platform: 'claude', status: 'running' },
  },
  tasks: {
    a: { id: 'a', coordinator: 'team-a', briefPath: '/x/a.md',
         writeScope: ['src/a/'], state: 'ready' },
  },
  limits: {},
  startedAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:05:00.000Z',
  ...over,
});

describe('renderStatusMarkdown', () => {
  it('reports the run headline', () => {
    const md = renderStatusMarkdown(state());
    expect(md).toContain('# Run 2026-09-12-001');
    expect(md).toContain('active platform: **claude**');
    expect(md).toContain('abc123');
  });

  it('shows each session with its platform session id', () => {
    // CAPO's sessions are headless and appear in no host session list, so the
    // platform's own id is the only handle a person has on the conversation.
    const md = renderStatusMarkdown(state());
    expect(md).toContain('uuid-root');
    expect(md).toContain('claude --resume');
  });

  it('shows a dash for a session with no id yet', () => {
    expect(renderStatusMarkdown(state())).toMatch(/\| team-a \|.*\| - \|/);
  });

  it('lists tasks with their write scopes', () => {
    const md = renderStatusMarkdown(state());
    expect(md).toContain('src/a/');
  });

  it('reports usage limits including an unknown reset time', () => {
    const md = renderStatusMarkdown(state({
      limits: {
        claude: { detectedAt: '2026-09-12T14:00:00.000Z', raw: 'limit reached' },
        codex: { detectedAt: '2026-09-12T15:00:00.000Z',
                 resetAt: '2026-09-12T18:00:00.000Z', raw: 'rate limited' },
      },
    }));
    expect(md).toContain('## Usage limits seen');
    expect(md).toContain('resets unknown');
    expect(md).toContain('2026-09-12T18:00:00.000Z');
  });

  it('says a parked run is parked, not dead, and how to continue it', () => {
    const md = renderStatusMarkdown(state({ status: 'waiting' }));
    expect(md).toContain('parked, not dead');
    expect(md).toContain('capo resume 2026-09-12-001');
  });

  it('handles a run with nothing in it yet', () => {
    const md = renderStatusMarkdown(state({ sessions: {}, tasks: {}, baseCommit: '' }));
    expect(md).toContain('_none running_');
    expect(md).toContain('_no tasks registered yet_');
    expect(md).toContain('(not yet set)');
  });
});
