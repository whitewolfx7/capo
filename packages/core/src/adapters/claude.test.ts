import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude.js';
import { eventOfKind, firstEvent, opts0, runAdapterConformance } from './conformance.js';

const stub = fileURLToPath(new URL('./__fixtures__/claude-stub.mjs', import.meta.url));

const make = async () => new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });

runAdapterConformance('claude-code', make);

describe('ClaudeAdapter argv', () => {
  it('passes model, session id and streaming flags to the child process', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start({ ...opts0(), model: 'opus', systemPrompt: 'be root', prompt: 'go' });

    // The stub echoes its own argv as its first stdout line; the adapter
    // captures that out-of-band (as `lastArgv`) rather than feeding it
    // through events(), because conformance requires `ready` to be the very
    // first event a fresh session's events() ever yields.
    const first = await firstEvent(s);
    expect(first.kind).toBe('ready');

    const argv = a.lastArgv ?? [];
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--input-format');
    expect(argv).toContain('--model');
    expect(argv).toContain('opus');
    expect(argv).toContain('--append-system-prompt');
    expect(argv).toContain('--session-id');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
    expect(argv).toContain('-p');

    await s.close();
  });

  it('exposes platformSessionId as soon as start() resolves, matching the --session-id argv', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start(opts0());
    expect(s.platformSessionId).toBeTruthy();
    await s.close();
  });

  it('maps a usage limit assistant message to a usage-limit event with a reset time', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start({ ...opts0(), prompt: '__EMIT_LIMIT__' });
    const e = await eventOfKind(s, 'usage-limit');
    expect(e.kind).toBe('usage-limit');
    if (e.kind === 'usage-limit') {
      expect(e.raw).toMatch(/usage limit reached/i);
      // resetAt is contractually an ISO timestamp the orchestrator compares
      // against now, so assert it is genuinely usable rather than pinning the
      // platform's human wording (which lives in `raw`).
      expect(e.resetAt).toBeDefined();
      expect(Number.isNaN(new Date(e.resetAt!).getTime())).toBe(false);
      expect(new Date(e.resetAt!).getUTCHours()).toBe(15);
      expect(e.raw).toMatch(/3pm/);
    }
    await s.close();
  });

  it('maps assistant text and tool_use blocks, then a result to turn-end', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start(opts0());
    await eventOfKind(s, 'ready');
    // The initial prompt ("go", from opts0()) is itself a turn: drain it
    // before sending a second one, so the assertions below unambiguously
    // see the reply to "hello there" rather than the reply to "go".
    await eventOfKind(s, 'turn-end');
    await s.send('hello there');
    const text = await eventOfKind(s, 'text');
    expect(text.kind).toBe('text');
    if (text.kind === 'text') expect(text.text).toContain('echo: hello there');
    const turnEnd = await eventOfKind(s, 'turn-end');
    expect(turnEnd.kind).toBe('turn-end');
    await s.close();
  });

  it('maps a non-zero exit to an exit event rather than throwing', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub, '--crash'] });
    const s = await a.start(opts0());
    const e = await eventOfKind(s, 'exit');
    if (e.kind === 'exit') expect(e.code).not.toBe(0);
  });

  it('close() ends stdin, waits for exit, and does not hang the happy path', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start(opts0());
    const start = Date.now();
    await s.close();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('ClaudeAdapter.doctor', () => {
  it('reports the version when the executable answers --version', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const d = await a.doctor();
    expect(d.ok).toBe(true);
    expect(d.version).toContain('Claude Code');
    expect(d.problems).toEqual([]);
  });

  it('reports not ok with a usable problem when the executable is missing', async () => {
    const a = new ClaudeAdapter({ executable: '/nonexistent/claude-does-not-exist' });
    const d = await a.doctor();
    expect(d.ok).toBe(false);
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0]).toMatch(/claude-does-not-exist/);
  });

  it('does not throw when the executable exits non-zero', async () => {
    // A script path before --version means node runs the script rather than
    // printing its own version, so this genuinely exercises a non-zero exit
    // (the shape of a broken install).
    const a = new ClaudeAdapter({
      executable: process.execPath,
      extraArgs: ['/nonexistent/not-a-real-script.mjs'],
    });
    await expect(a.doctor()).resolves.toMatchObject({ ok: false });
  });
});
