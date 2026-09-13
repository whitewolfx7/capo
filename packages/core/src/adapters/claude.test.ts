import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude.js';
import { eventOfKind, firstEvent, opts0, runAdapterConformance } from './conformance.js';
import type { AdapterEvent } from '../types.js';

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
    expect(argv).toContain('bypassPermissions');
    expect(argv).toContain('-p');
    expect(a.lastArgv).toEqual(expect.arrayContaining(['--setting-sources', 'project,local']));

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

  it('emits ready only once, even though the CLI re-sends system/init before every turn', async () => {
    // A live run against the real CLI showed `system`/`init` is re-emitted
    // before every turn, not just the first. Left unguarded, that would put
    // a second `ready` event on the queue mid-stream after a second turn.
    // Single consumer throughout: `events()` returns one shared queue, and
    // draining it from two places at once (e.g. a background pump AND
    // `eventOfKind`) would race for the same events non-deterministically.
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start(opts0());
    const seen: AdapterEvent['kind'][] = [];
    let turnEnds = 0;
    for await (const e of s.events()) {
      seen.push(e.kind);
      if (e.kind === 'turn-end') {
        turnEnds += 1;
        if (turnEnds === 1) await s.send('second turn');
        else if (turnEnds === 2) await s.send('third turn');
        // A third turn to be doubly sure a later system/init still doesn't
        // slip a ready event through.
        else break;
      }
    }
    await s.close();
    expect(seen.filter((k) => k === 'ready')).toHaveLength(1);
  });

  it('maps a rate_limit_event with status "rejected" to a usage-limit event', async () => {
    // The real limit signal is this structured event, not prose in
    // assistant text (see the header note in claude.ts).
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start({ ...opts0(), prompt: '__EMIT_RATE_LIMIT_REJECTED__' });
    const e = await eventOfKind(s, 'usage-limit');
    expect(e.kind).toBe('usage-limit');
    if (e.kind === 'usage-limit') {
      expect(e.resetAt).toBeDefined();
      expect(Number.isNaN(new Date(e.resetAt!).getTime())).toBe(false);
      expect(e.raw).toMatch(/rejected/);
    }
    await s.close();
  });

  it('does not surface a rate_limit_event with status "allowed" as a usage-limit', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start({ ...opts0(), prompt: '__EMIT_RATE_LIMIT_ALLOWED__' });
    const seen: AdapterEvent['kind'][] = [];
    for await (const e of s.events()) {
      seen.push(e.kind);
      if (e.kind === 'turn-end') break;
    }
    await s.close();
    expect(seen).not.toContain('usage-limit');
  });

  it('maps a result with is_error true to a non-retryable error ahead of turn-end', async () => {
    // A `result` can fail (bad input, a refusal, an API error) without any
    // assistant text describing it; that must not be silently swallowed as
    // a plain turn-end.
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start({ ...opts0(), prompt: '__EMIT_ERROR_RESULT__' });
    const seen: AdapterEvent[] = [];
    for await (const e of s.events()) {
      seen.push(e);
      if (e.kind === 'turn-end') break;
    }
    const errIdx = seen.findIndex((e) => e.kind === 'error');
    const endIdx = seen.findIndex((e) => e.kind === 'turn-end');
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(errIdx);
    const err = seen[errIdx];
    if (err?.kind === 'error') {
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/refused/);
    }
    await s.close();
  });

  it('maps a mid-session non-zero exit to an exit event rather than throwing', async () => {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub, '--crash'] });
    const s = await a.start(opts0());
    const e = await eventOfKind(s, 'exit');
    if (e.kind === 'exit') expect(e.code).not.toBe(0);
  });

  it('rejects start() when the process dies before it is ever ready', async () => {
    // A dead session handed back as if it were live is worse than an error:
    // the orchestrator would record it as running and wait forever.
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub, '--crash-early'] });
    await expect(a.start(opts0())).rejects.toThrow(/exited|ready/i);
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

describe('ClaudeAdapter autonomy', () => {
  /**
   * A headless session has nobody to answer an approval request, so the
   * autonomy level really chooses between "allowed to act" and "dry run".
   * Claude used to hardcode acceptEdits regardless, which made `supervised`
   * a lie: the config said one thing and the session did another.
   */
  async function permissionModeFor(autonomy?: 'supervised' | 'autonomous'): Promise<string> {
    const a = new ClaudeAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start({
      sessionId: 'root', role: 'root', model: 'haiku', cwd: process.cwd(),
      systemPrompt: 'be root', prompt: 'go',
      ...(autonomy ? { autonomy } : {}),
    });
    const argv = a.lastArgv ?? [];
    await s.close();
    const i = argv.indexOf('--permission-mode');
    expect(i, 'the flag is present').toBeGreaterThan(-1);
    return argv[i + 1]!;
  }

  // Must be a mode that permits Bash, not merely file edits. A full live run
  // died on exactly that distinction: both coordinators wrote their fix and
  // then could not run the tests or `git commit`, so neither could ever
  // produce the result commit a task is finished by.
  it('grants enough to run commands when autonomous, not just to edit files', async () => {
    expect(await permissionModeFor('autonomous')).toBe('bypassPermissions');
  });

  it('only reads and plans when supervised', async () => {
    expect(await permissionModeFor('supervised')).toBe('plan');
  });

  it('defaults to acting, matching the config default', async () => {
    expect(await permissionModeFor()).toBe('bypassPermissions');
  });
});
