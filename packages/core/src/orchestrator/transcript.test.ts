import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  appendTranscript, renderEvent, renderSessionHeader, transcriptPath,
} from './transcript.js';
import type { AdapterEvent } from '../types.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'capo-tx-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('renderEvent', () => {
  it('shows assistant text', () => {
    expect(renderEvent({ kind: 'text', text: 'working on the client' }))
      .toContain('working on the client');
  });

  it('skips empty text rather than writing blank lines', () => {
    expect(renderEvent({ kind: 'text', text: '   ' })).toBeUndefined();
  });

  it('skips ready, since the launch header already says so', () => {
    expect(renderEvent({ kind: 'ready', platformSessionId: 'x' })).toBeUndefined();
  });

  it('marks a tool call', () => {
    expect(renderEvent({ kind: 'tool', name: 'Edit', detail: 'src/a.ts' }))
      .toMatch(/tool.*Edit.*src\/a\.ts/);
  });

  it('makes a usage limit impossible to miss and says what CAPO is doing', () => {
    const out = renderEvent({
      kind: 'usage-limit', raw: 'limit reached', resetAt: '2026-09-12T18:00:00.000Z',
    })!;
    expect(out).toContain('USAGE LIMIT');
    expect(out).toContain('2026-09-12T18:00:00.000Z');
    expect(out).toMatch(/moving the team to the other platform/i);
  });

  it('says so plainly when no reset time was reported', () => {
    expect(renderEvent({ kind: 'usage-limit', raw: 'limited' })!)
      .toContain('no reset time reported');
  });

  it('distinguishes a retryable error', () => {
    expect(renderEvent({ kind: 'error', message: 'boom', retryable: true }))
      .toContain('retryable');
  });

  it('covers every event kind without throwing', () => {
    const all: AdapterEvent[] = [
      { kind: 'ready', platformSessionId: 'x' },
      { kind: 'text', text: 'hi' },
      { kind: 'tool', name: 'Read' },
      { kind: 'usage-limit', raw: 'limit' },
      { kind: 'turn-end' },
      { kind: 'error', message: 'e', retryable: false },
      { kind: 'exit', code: 1 },
    ];
    for (const e of all) expect(() => renderEvent(e)).not.toThrow();
  });
});

describe('renderSessionHeader', () => {
  it('names the platform and model, and marks a resume', () => {
    // A transcript spans platform switches, so the header is what makes it
    // obvious where the session moved and which model took over.
    expect(renderSessionHeader('team-a', 'codex', 'gpt-5-codex', true))
      .toMatch(/Resumed on codex \(gpt-5-codex\)/);
    expect(renderSessionHeader('team-a', 'claude', 'sonnet', false))
      .toMatch(/Started on claude \(sonnet\)/);
  });
});

describe('appendTranscript', () => {
  it('creates the directory and appends in order', async () => {
    await appendTranscript(dir, 'team-a', 'first\n');
    await appendTranscript(dir, 'team-a', 'second\n');
    expect(await readFile(transcriptPath(dir, 'team-a'), 'utf8')).toBe('first\nsecond\n');
  });

  it('keeps sessions in separate files', async () => {
    await appendTranscript(dir, 'team-a', 'a\n');
    await appendTranscript(dir, 'team-b', 'b\n');
    expect(await readFile(transcriptPath(dir, 'team-b'), 'utf8')).toBe('b\n');
  });

  it('never throws, so a transcript cannot fail a run', async () => {
    // An unwritable location is the realistic case; the run must not care.
    await expect(appendTranscript('/proc/nonexistent/nope', 'x', 'y')).resolves.toBeUndefined();
  });

  it('cannot be made to write outside the run directory by a session id', () => {
    // Path separators are replaced, so traversal collapses into a harmless
    // (if ugly) filename. What matters is that the file lands in the
    // transcripts directory and nowhere else.
    for (const hostile of ['../../escape', '/etc/passwd', 'a/b/c', '..']) {
      const p = transcriptPath(dir, hostile);
      expect(dirname(p), hostile).toBe(join(dir, 'transcripts'));
      expect(basename(p), hostile).not.toContain('/');
    }
  });
});
