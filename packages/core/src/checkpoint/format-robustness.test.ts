import { describe, expect, it } from 'vitest';
import { renderCheckpoint, parseCheckpoint } from './render.js';
import type { Checkpoint } from '../types.js';

const base: Checkpoint = {
  sessionId: 'team-a', runId: 'r1', role: 'coordinator', platform: 'claude',
  written: '2026-09-12T14:20:05.000Z', baseCommit: 'abc',
  objective: 'x', decisions: [], done: [], inProgress: [], remaining: [], blockers: [],
};

/**
 * The checkpoint format is what carries an agent's working context from one
 * platform to another. If a round-trip mangles content, work is silently lost
 * at exactly the moment a user is already having a bad time. These cases are
 * the ones most likely to break a hand-rolled Markdown parser.
 */
describe('checkpoint format robustness', () => {
  const cases: Record<string, Partial<Checkpoint>> = {
    'bullet that looks like a heading': { done: ['## Done', '### nested'] },
    'bullet containing a fenced block marker': { done: ['```json', 'x'] },
    'bullet that is literally _none_': { blockers: ['_none_'] },
    'objective spanning blank lines': { objective: 'line one\n\nline two' },
    'unicode and emoji': { remaining: ['日本語 café 🚀', 'naïve'] },
    'trailing and leading whitespace': { done: ['  padded  '] },
    'bullet starting with a dash': { done: ['- already a bullet'] },
    'very long single bullet': { done: ['x'.repeat(5000)] },
    'colon-bearing line like a header field': { done: ['run: not-a-header'] },
    'empty string bullet': { done: [''] },
  };
  for (const [name, over] of Object.entries(cases)) {
    it(name, () => {
      const cp = { ...base, ...over };
      expect(parseCheckpoint(renderCheckpoint(cp))).toEqual(cp);
    });
  }
});
