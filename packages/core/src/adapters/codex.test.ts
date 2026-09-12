import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, AdapterSession } from '../types.js';
import { CapoError } from '../types.js';
import { CodexAdapter, composeFirstTurn } from './codex.js';
import { eventOfKind, opts0, runAdapterConformance } from './conformance.js';

const stub = fileURLToPath(new URL('./__fixtures__/codex-stub.mjs', import.meta.url));

/** A session as returned by CodexAdapter, plus the test-only introspection
 * field it carries beyond the AdapterSession contract (see codex.ts). */
type DebugSession = AdapterSession & { debugArgv: string[][] };

const make = async () => new CodexAdapter({ executable: process.execPath, extraArgs: [stub] });

runAdapterConformance('codex-exec', make);

describe('CodexAdapter argv', () => {
  it('passes exec --json -m <model> <prompt> on the first turn', async () => {
    const adapter = new CodexAdapter({ executable: process.execPath, extraArgs: [stub] });
    const session = (await adapter.start({ ...opts0(), model: 'gpt-5-codex' })) as DebugSession;

    const argv = session.debugArgv[0]!;
    expect(argv.slice(0, 4)).toEqual(['exec', '--json', '-m', 'gpt-5-codex']);
    // The last argument is the composed first turn: system prompt (if any)
    // then the first user instruction, because codex exec has no
    // --append-system-prompt and PROMPT is the only input channel.
    expect(argv).toHaveLength(5);
    expect(argv[4]).toContain('go');

    await session.close();
  });

  it('adds no autonomy flag when autonomy is left unset (the "supervised" default)', async () => {
    const adapter = new CodexAdapter({ executable: process.execPath, extraArgs: [stub] });
    const session = (await adapter.start(opts0())) as DebugSession;
    expect(session.debugArgv[0]).not.toContain('--approve-for-me');
    await session.close();
  });

  it('passes --approve-for-me on every turn, first and resumed, when autonomy is "autonomous"', async () => {
    const adapter = new CodexAdapter({ executable: process.execPath, extraArgs: [stub] });
    const session = (await adapter.start({ ...opts0(), autonomy: 'autonomous' })) as DebugSession;

    // Placed right after `exec`, ahead of --json/-m: verified against a real
    // `codex exec --approve-for-me resume --help` that this parses correctly
    // whether or not a `resume` subcommand follows (see codex.ts).
    expect(session.debugArgv[0]).toEqual([
      'exec',
      '--approve-for-me',
      '--json',
      '-m',
      'test-model',
      expect.any(String),
    ]);

    // Drain through the first turn's turn-end before sending a second turn,
    // then through the second turn's, so the resumed child's argv-echo line
    // (read off its stdout, same as the first child's) is guaranteed to have
    // landed in debugArgv before it's asserted on below.
    const iterator = session.events()[Symbol.asyncIterator]();
    async function nextOfKind(kind: AdapterEvent['kind']): Promise<void> {
      for (;;) {
        const result = await iterator.next();
        if (result.done) throw new Error(`stream ended before a "${kind}" event`);
        if (result.value?.kind === kind) return;
      }
    }
    await nextOfKind('turn-end');
    await session.send('second turn');
    await nextOfKind('turn-end');

    const resumeArgv = session.debugArgv[1]!;
    expect(resumeArgv[0]).toBe('exec');
    expect(resumeArgv[1]).toBe('--approve-for-me');
    expect(resumeArgv).toContain('resume');

    await session.close();
  });

  it('captures the platform session id from the session-configured event before start() returns', async () => {
    const adapter = new CodexAdapter({ executable: process.execPath, extraArgs: [stub] });
    const session = await adapter.start(opts0());

    expect(session.platformSessionId).toBeTruthy();
    expect(typeof session.platformSessionId).toBe('string');

    await session.close();
  });

  it('maps a rate-limit-shaped event to usage-limit', async () => {
    const adapter = new CodexAdapter({ executable: process.execPath, extraArgs: [stub] });
    const session = await adapter.start({ ...opts0(), prompt: '__EMIT_LIMIT__' });

    const event = await eventOfKind(session, 'usage-limit');
    expect(event.kind).toBe('usage-limit');
    if (event.kind === 'usage-limit') {
      expect(event.raw).toMatch(/usage limit/i);
    }

    await session.close();
  });
});

describe('CodexAdapter multi-turn resume', () => {
  it('keeps one event stream across two child processes, and resumes with the captured session id', async () => {
    const adapter = new CodexAdapter({ executable: process.execPath, extraArgs: [stub] });
    const session = (await adapter.start({ ...opts0(), prompt: 'first turn' })) as DebugSession;
    const sessionId = session.platformSessionId;
    expect(sessionId).toBeTruthy();

    const seen: AdapterEvent[] = [];
    const iterator = session.events()[Symbol.asyncIterator]();

    async function nextOfKind(kind: AdapterEvent['kind']): Promise<AdapterEvent> {
      for (;;) {
        const result = await iterator.next();
        if (result.done || result.value === undefined) {
          throw new Error(`event stream ended before a "${kind}" event arrived`);
        }
        seen.push(result.value);
        if (result.value.kind === kind) return result.value;
      }
    }

    // Drains 'ready' and the first turn's 'text' event along the way.
    await nextOfKind('turn-end');

    await session.send('second turn');

    // Drains the second turn's 'text' event along the way. This only
    // resolves if the child spawned for send() feeds the SAME session's
    // event stream rather than a disconnected one, and if a normal turn
    // boundary (task_complete -> turn-end) does not itself end the stream.
    await nextOfKind('turn-end');

    const texts = seen.filter((e): e is Extract<AdapterEvent, { kind: 'text' }> => e.kind === 'text');
    expect(texts).toHaveLength(2);
    expect(texts[0]?.text).toContain('first turn');
    expect(texts[1]?.text).toContain('second turn');

    expect(session.debugArgv).toHaveLength(2);
    expect(session.debugArgv[0]).not.toContain('resume');
    expect(session.debugArgv[1]?.[0]).toBe('exec');
    expect(session.debugArgv[1]?.[1]).toBe('resume');
    expect(session.debugArgv[1]?.[2]).toBe(sessionId);
    expect(session.debugArgv[1]).toContain('--json');

    await session.close();

    // events() still terminates promptly after close(), even mid multi-turn.
    const drained = await iterator.next();
    expect(drained.done).toBe(true);
  });
});

describe('CodexAdapter app-server mode', () => {
  it('start() throws CapoError, unimplemented in v0.1', async () => {
    const adapter = new CodexAdapter({ executable: process.execPath, extraArgs: [stub], mode: 'app-server' });

    await expect(adapter.start(opts0())).rejects.toThrow(CapoError);
    await expect(adapter.start(opts0())).rejects.toThrow('app-server mode is not implemented in v0.1');
  });
});

describe('CodexAdapter system prompt delivery', () => {
  /**
   * `codex exec` has no --append-system-prompt, so the system prompt must ride
   * in the PROMPT argument. An earlier version dropped it entirely. A live run
   * showed real Codex sessions replying that no objective was visible, and
   * they would also have had no knowledge of the checkpoint protocol, which
   * means no session could ever have survived a platform switch.
   */
  it('puts the system prompt on the command line, ahead of the first turn', async () => {
    const a = new CodexAdapter({ executable: process.execPath, extraArgs: [stub] });
    const s = await a.start({
      sessionId: 'team-a', role: 'coordinator', model: 'gpt-5.6-sol',
      cwd: process.cwd(),
      systemPrompt: '## Objective\nShip the thing.\n\n## Your ownership\nsrc/a/',
      prompt: 'Begin work.',
    });
    const argv = (s as unknown as DebugSession).debugArgv[0]!;
    const blob = argv[argv.length - 1]!;
    expect(blob).toContain('Ship the thing.');
    expect(blob).toContain('src/a/');
    expect(blob).toContain('Begin work.');
    expect(blob.indexOf('Ship the thing.')).toBeLessThan(blob.indexOf('Begin work.'));
    await s.close();
  });

  it('sends just the prompt when there is no system prompt', () => {
    expect(composeFirstTurn({
      sessionId: 'x', role: 'worker', model: 'm', cwd: '.',
      systemPrompt: '   ', prompt: 'go',
    })).toBe('go');
  });

  it('keeps the checkpoint protocol intact, since a switch depends on it', () => {
    const out = composeFirstTurn({
      sessionId: 'x', role: 'coordinator', model: 'm', cwd: '.',
      systemPrompt: 'Checkpoint protocol: reply with a fenced block titled # Checkpoint: <id>',
      prompt: 'go',
    });
    expect(out).toContain('Checkpoint protocol');
    expect(out).toContain('# Checkpoint:');
  });
});
