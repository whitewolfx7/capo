import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from './claude.js';
import type { AdapterEvent } from '../types.js';

const replay = fileURLToPath(new URL('./__fixtures__/claude-replay.mjs', import.meta.url));
const stream = fileURLToPath(new URL('./__fixtures__/claude-real-stream.jsonl', import.meta.url));
const toolcall = fileURLToPath(
  new URL('./__fixtures__/claude-real-toolcall.jsonl', import.meta.url),
);

/**
 * These assertions run against REAL captures of `claude -p --output-format
 * stream-json` (Claude Code 2.1.236, 2026-09-13), not against shapes we
 * invented. See the header of `claude.ts` for the full list of what a live
 * run confirmed and what it corrected.
 *
 * `claude-real-stream.jsonl` is a two-turn session: the first turn asks the
 * model to repeat a codeword that appears ONLY in `--append-system-prompt`
 * (proving the system prompt is genuinely delivered, not dropped the way
 * the Codex adapter's was); the second turn is a follow-up `send()` on the
 * same process. Between the two turns the real CLI re-emits a `system`/
 * `init` line carrying the SAME session id — the adapter must not treat
 * that as a second `ready`.
 */
describe('ClaudeAdapter against a real captured stream', () => {
  async function drain(): Promise<AdapterEvent[]> {
    const adapter = new ClaudeAdapter({ executable: process.execPath, extraArgs: [replay, stream] });
    const session = await adapter.start({
      sessionId: 'team-a',
      role: 'coordinator',
      model: 'haiku',
      cwd: process.cwd(),
      systemPrompt: 'You are a test agent. The secret codeword is BANANA77.',
      prompt: 'go',
    });
    const seen: AdapterEvent[] = [];
    const pump = (async () => {
      for await (const e of session.events()) seen.push(e);
    })();
    await new Promise((r) => setTimeout(r, 150));
    await session.close();
    await pump;
    return seen;
  }

  it('becomes ready from system/init, carrying the real session id', async () => {
    const events = await drain();
    const ready = events.find((e) => e.kind === 'ready');
    expect(ready, 'a ready event, or start() would hang forever').toBeDefined();
    if (ready?.kind === 'ready') {
      expect(ready.platformSessionId).toBe('20597d4d-dd9e-4ece-8809-21cfe7988d86');
    }
  });

  it('emits ready exactly once, despite the real CLI re-sending system/init before the second turn', async () => {
    const events = await drain();
    expect(events.filter((e) => e.kind === 'ready')).toHaveLength(1);
  });

  it('surfaces the system-prompt-only codeword as assistant text, proving the system prompt was delivered', async () => {
    const events = await drain();
    const texts = events.filter((e) => e.kind === 'text');
    expect(texts.some((e) => e.kind === 'text' && e.text.includes('BANANA77'))).toBe(true);
  });

  it('ends both turns captured in the stream', async () => {
    const events = await drain();
    expect(events.filter((e) => e.kind === 'turn-end')).toHaveLength(2);
  });

  it('does not mistake the "allowed" rate_limit_event in this stream for a usage limit', async () => {
    const events = await drain();
    expect(events.some((e) => e.kind === 'usage-limit')).toBe(false);
  });
});

/**
 * `claude-real-toolcall.jsonl` captures a single turn where the model
 * actually calls a tool (`Bash`) and gets a real tool result back before
 * replying. This is the evidence for the `tool_use` block shape, and for
 * the (unrelated but notable) finding that `--permission-mode acceptEdits`
 * in `-p` mode auto-approves tool calls rather than stalling on approval
 * the way a live Codex run did.
 */
describe('ClaudeAdapter against a real captured tool-call turn', () => {
  async function drain(): Promise<AdapterEvent[]> {
    const adapter = new ClaudeAdapter({
      executable: process.execPath,
      extraArgs: [replay, toolcall],
    });
    const session = await adapter.start({
      sessionId: 'team-a',
      role: 'worker',
      model: 'haiku',
      cwd: process.cwd(),
      systemPrompt: 'You are a coding assistant.',
      prompt: 'go',
    });
    const seen: AdapterEvent[] = [];
    const pump = (async () => {
      for await (const e of session.events()) seen.push(e);
    })();
    await new Promise((r) => setTimeout(r, 150));
    await session.close();
    await pump;
    return seen;
  }

  it('becomes ready from the real session id', async () => {
    const events = await drain();
    const ready = events.find((e) => e.kind === 'ready');
    expect(ready?.kind === 'ready' && ready.platformSessionId).toBe(
      '4ac010bd-4b82-4cdf-b7b6-38c5765440f2',
    );
  });

  it('maps the real tool_use block to a tool event', async () => {
    const events = await drain();
    const tool = events.find((e) => e.kind === 'tool');
    expect(tool, 'a tool event for the Bash call').toBeDefined();
    if (tool?.kind === 'tool') {
      expect(tool.name).toBe('Bash');
      expect(tool.detail).toContain('echo HELLO_FROM_BASH');
    }
  });

  it('surfaces the final assistant reply as text after the tool result', async () => {
    const events = await drain();
    const texts = events.filter((e) => e.kind === 'text');
    expect(texts.some((e) => e.kind === 'text' && e.text.includes('HELLO_FROM_BASH'))).toBe(true);
  });

  it('ends the turn once, with no spurious errors', async () => {
    const events = await drain();
    expect(events.filter((e) => e.kind === 'turn-end')).toHaveLength(1);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });
});
