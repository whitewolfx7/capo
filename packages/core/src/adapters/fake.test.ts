import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '../types.js';
import { eventOfKind, firstEvent, opts0, runAdapterConformance } from './conformance.js';
import { emitLimit, FakeAdapter } from './fake.js';

runAdapterConformance('fake', async () => new FakeAdapter('fake'));

function checkpoint(sessionId: string): Checkpoint {
  return {
    sessionId,
    runId: 'run-1',
    role: 'coordinator',
    platform: 'fake',
    written: '2026-09-12T00:00:00Z',
    baseCommit: 'deadbeef',
    objective: 'ship the thing',
    decisions: ['used a fake adapter'],
    done: ['wrote tests'],
    inProgress: ['writing the adapter'],
    remaining: ['nothing'],
    blockers: [],
  };
}

describe('FakeAdapter scripting', () => {
  it('records started calls with role, model and cwd', async () => {
    const adapter = new FakeAdapter('fake');
    const s = await adapter.start({
      sessionId: 'team-a',
      role: 'coordinator',
      model: 'sonnet',
      cwd: '/tmp/workspace',
      systemPrompt: 'be a coordinator',
      prompt: 'go',
    });
    await s.close();

    expect(adapter.started).toHaveLength(1);
    expect(adapter.started[0]).toMatchObject({
      sessionId: 'team-a',
      role: 'coordinator',
      model: 'sonnet',
      cwd: '/tmp/workspace',
    });
  });

  it('honours the __EMIT_LIMIT__ prompt sentinel', async () => {
    const adapter = new FakeAdapter('fake');
    const s = await adapter.start({ ...opts0(), prompt: 'please __EMIT_LIMIT__ now' });
    const e = await eventOfKind(s, 'usage-limit');
    expect(e.kind).toBe('usage-limit');
    await s.close();
  });

  it('a scripted usage-limit event, pushed via emit(), arrives on the events iterator', async () => {
    const adapter = new FakeAdapter('fake');
    const s = await adapter.start(opts0());
    await firstEvent(s); // drain the 'ready' event first

    adapter.emit('root', emitLimit('2026-09-12T18:00:00Z'));

    const e = await eventOfKind(s, 'usage-limit');
    if (e.kind !== 'usage-limit') throw new Error('expected usage-limit');
    expect(e.resetAt).toBe('2026-09-12T18:00:00Z');
    await s.close();
  });

  it('onStart script events are queued right after ready', async () => {
    const adapter = new FakeAdapter('fake', {
      onStart: [{ kind: 'text', text: 'hello from script' }],
    });
    const s = await adapter.start(opts0());
    const seen: string[] = [];
    for await (const e of s.events()) {
      seen.push(e.kind);
      if (e.kind === 'text') break;
    }
    expect(seen).toEqual(['ready', 'text']);
    await s.close();
  });

  it('onSend script produces events keyed by turn number', async () => {
    const turns: number[] = [];
    const adapter = new FakeAdapter('fake', {
      onSend: (text, turn) => {
        turns.push(turn);
        return [{ kind: 'text', text: `echo:${text}` }, { kind: 'turn-end' }];
      },
    });
    const s = await adapter.start(opts0());
    await firstEvent(s);

    await s.send('first');
    await s.send('second');

    expect(turns).toEqual([0, 1]);
    expect(adapter.sent).toEqual([
      { sessionId: 'root', text: 'first' },
      { sessionId: 'root', text: 'second' },
    ]);
  });

  it('failNextStart makes exactly the next start() reject, and only the next one', async () => {
    const adapter = new FakeAdapter('fake');
    adapter.failNextStart('platform unavailable');

    await expect(adapter.start(opts0())).rejects.toThrow('platform unavailable');

    const s = await adapter.start(opts0());
    const first = await firstEvent(s);
    expect(first.kind).toBe('ready');
    await s.close();
  });

  it('replyWithCheckpoint arms a fenced checkpoint block as the next reply', async () => {
    const adapter = new FakeAdapter('fake');
    const s = await adapter.start({ ...opts0(), sessionId: 'team-a' });
    await firstEvent(s);

    adapter.replyWithCheckpoint('team-a', checkpoint('team-a'));
    await s.send('CHECKPOINT_REQUEST');

    const e = await eventOfKind(s, 'text');
    if (e.kind !== 'text') throw new Error('expected text');
    const fenceMatch = e.text.match(/```[a-z]*\n([\s\S]*?)\n```/);
    expect(fenceMatch).not.toBeNull();
    const body = fenceMatch![1] ?? '';
    expect(body.split('\n')[0]).toBe('# Checkpoint: team-a');
    await s.close();
  });

  it('emit() throws for a session that was never started', () => {
    const adapter = new FakeAdapter('fake');
    expect(() => adapter.emit('nope', emitLimit())).toThrow();
  });

  it('emit() throws for a session that is already closed', async () => {
    const adapter = new FakeAdapter('fake');
    const s = await adapter.start(opts0());
    await s.close();
    expect(() => adapter.emit('root', emitLimit())).toThrow();
  });

  it('records every close() in order, and it is idempotent in the closed log', async () => {
    const adapter = new FakeAdapter('fake');
    const a = await adapter.start({ ...opts0(), sessionId: 'a' });
    const b = await adapter.start({ ...opts0(), sessionId: 'b' });
    await b.close();
    await a.close();
    await a.close();
    expect(adapter.closed).toEqual(['b', 'a']);
  });

  it('two concurrently started sessions have completely independent event streams', async () => {
    const adapter = new FakeAdapter('fake');
    const a = await adapter.start({ ...opts0(), sessionId: 'a' });
    const b = await adapter.start({ ...opts0(), sessionId: 'b' });
    await firstEvent(a);
    await firstEvent(b);

    adapter.emit('a', { kind: 'text', text: 'only for a' });
    adapter.emit('b', { kind: 'text', text: 'only for b' });

    const eventsA: string[] = [];
    for await (const e of a.events()) {
      if (e.kind === 'text') {
        eventsA.push(e.text);
        break;
      }
    }
    const eventsB: string[] = [];
    for await (const e of b.events()) {
      if (e.kind === 'text') {
        eventsB.push(e.text);
        break;
      }
    }

    expect(eventsA).toEqual(['only for a']);
    expect(eventsB).toEqual(['only for b']);
    await a.close();
    await b.close();
  });

  it('honours a scripted doctor() result', async () => {
    const adapter = new FakeAdapter('fake', { doctor: { ok: false, problems: ['not installed'] } });
    const d = await adapter.doctor();
    expect(d).toEqual({ ok: false, problems: ['not installed'] });
  });
});
