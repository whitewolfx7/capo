import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt } from './prompt.js';
import type { CapoConfig, Checkpoint } from '../types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'capo-prompt-'));
  await writeFile(join(dir, 'GOAL.md'), 'Ship the thing.\n');
  await writeFile(join(dir, 'w.md'), 'Do one bounded piece of work.\n');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const config = (): CapoConfig => ({
  version: 1, configPath: join(dir, 'c.yaml'), workspace: dir,
  objective: join(dir, 'GOAL.md'),
  platforms: { claude: { driver: 'claude-code' }, codex: { driver: 'codex' } },
  startOn: 'claude',
  models: {
    root: { claude: 'opus', codex: 'gpt-5-codex' },
    coordinator: { claude: 'sonnet', codex: 'gpt-5-codex' },
    worker: { claude: 'haiku', codex: 'gpt-5-codex' },
  },
  roles: { root: 'r.md', coordinator: 'c.md', worker: join(dir, 'w.md') },
  context: [],
  coordinators: [{ id: 'team-a' }],
  tasks: [{ id: 'a', coordinator: 'team-a', brief: 'a.md', writeScope: ['src/a/'] }],
  limits: { maxWorkersPerCoordinator: 2 },
});

const checkpoint = (): Checkpoint => ({
  sessionId: 'team-a', runId: 'r1', role: 'coordinator', platform: 'claude',
  written: '2026-09-12T14:20:05.000Z', baseCommit: 'abc',
  objective: 'Build the client.', decisions: [], done: ['wrote client.ts'],
  inProgress: [], remaining: ['tests'], blockers: [],
});

const build = (cp?: Checkpoint) => buildSystemPrompt({
  config: config(), role: 'coordinator', sessionId: 'team-a',
  contextFiles: [], roleInstructions: 'Own one component.',
  ...(cp ? { checkpoint: cp } : {}),
});

describe('buildSystemPrompt', () => {
  /** Drops fenced regions, leaving only the prompt's own structure. */
  function outsideFences(md: string): string[] {
    const lines = md.split('\n');
    const kept: string[] = [];
    let inFence = false;
    for (const line of lines) {
      if (line.startsWith('```')) { inFence = !inFence; continue; }
      if (!inFence) kept.push(line);
    }
    return kept;
  }

  it('fences the embedded checkpoint so its headings cannot be read as prompt sections', () => {
    const out = build(checkpoint());
    // The checkpoint carries its own `## Objective`. Unfenced, a reader sees
    // that heading twice meaning two different things, and the checkpoint's
    // sections merge into the prompt's own structure.
    const headings = outsideFences(out).filter((l) => l.startsWith('## '));
    expect(headings.filter((l) => l === '## Objective')).toHaveLength(1);
    expect(headings).not.toContain('## Decisions made');
    expect(headings).not.toContain('## Blockers and open questions');
    // And the checkpoint really is inside the fence.
    expect(outsideFences(out).join('\n')).not.toContain('# Checkpoint: team-a');
    expect(out).toContain('# Checkpoint: team-a');
  });

  it('tells the session it has no memory beyond the checkpoint', () => {
    expect(build(checkpoint())).toMatch(/no memory/i);
  });

  it('omits the checkpoint section entirely on a first launch', () => {
    const out = build();
    expect(out).not.toContain('checkpoint from the previous platform');
    // The checkpoint REQUEST instructions legitimately contain both a fenced
    // block and the literal template line `# Checkpoint: <your own session
    // id>`, since the session has to know how to answer one. What must be
    // absent is a filled-in checkpoint for this session.
    expect(out).not.toContain('# Checkpoint: team-a');
    expect(out).toMatch(/fenced/i);
  });

  it('always states the session id and its write scope', () => {
    const out = build();
    expect(out).toContain('team-a');
    expect(out).toContain('src/a/');
  });
});

describe('buildSystemPrompt worker delegation', () => {
  it('gives a coordinator the worker role instructions and the platform-specific worker model', () => {
    const out = buildSystemPrompt({
      config: config(), role: 'coordinator', sessionId: 'team-a', platform: 'claude',
      contextFiles: [], roleInstructions: 'Own one component.',
    });
    expect(out).toContain('## Delegating to workers');
    expect(out).toContain('Do one bounded piece of work.');
    expect(out).toContain('"haiku"');
    // The other platform's worker model must not leak in.
    expect(out).not.toContain('gpt-5-codex');
    // Honest about the limits of what CAPO can do here.
    expect(out).toMatch(/cannot enforce/i);
  });

  it('picks the worker model for whichever platform is passed in', () => {
    const out = buildSystemPrompt({
      config: config(), role: 'coordinator', sessionId: 'team-a', platform: 'codex',
      contextFiles: [], roleInstructions: 'Own one component.',
    });
    expect(out).toContain('"gpt-5-codex"');
    expect(out).not.toContain('"haiku"');
  });

  it('omits the section when no platform is given, for backward compatibility with existing callers', () => {
    const out = buildSystemPrompt({
      config: config(), role: 'coordinator', sessionId: 'team-a',
      contextFiles: [], roleInstructions: 'Own one component.',
    });
    expect(out).not.toContain('## Delegating to workers');
  });

  it('never gives the root a worker-delegation section, since only coordinators spawn workers', () => {
    const out = buildSystemPrompt({
      config: config(), role: 'root', sessionId: 'root', platform: 'claude',
      contextFiles: [], roleInstructions: 'Own the objective.',
    });
    expect(out).not.toContain('## Delegating to workers');
  });
});
