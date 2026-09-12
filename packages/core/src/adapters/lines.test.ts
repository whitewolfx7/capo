import { describe, expect, it } from 'vitest';
import { readJsonLines, type JsonLine } from './lines.js';

async function* from(...chunks: (string | Buffer)[]): AsyncIterable<string | Buffer> {
  for (const c of chunks) yield c;
}

async function collect(stream: AsyncIterable<string | Buffer>): Promise<JsonLine[]> {
  const out: JsonLine[] = [];
  for await (const l of readJsonLines(stream)) out.push(l);
  return out;
}

describe('readJsonLines', () => {
  it('parses one object per line', async () => {
    expect(await collect(from('{"a":1}\n{"a":2}\n'))).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { a: 2 } },
    ]);
  });

  it('reassembles a line split across chunks', async () => {
    expect(await collect(from('{"a"', ':1}\n'))).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('reassembles a line split across many chunks', async () => {
    expect(await collect(from('{', '"', 'a', '"', ':', '1', '}', '\n'))).toEqual([
      { ok: true, value: { a: 1 } },
    ]);
  });

  it('emits a final line that has no trailing newline', async () => {
    expect(await collect(from('{"a":1}'))).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('handles CRLF', async () => {
    expect(await collect(from('{"a":1}\r\n{"a":2}\r\n'))).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { a: 2 } },
    ]);
  });

  it('skips blank and whitespace-only lines', async () => {
    expect(await collect(from('\n  \n{"a":1}\n\n'))).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('yields a malformed line as ok:false instead of throwing', async () => {
    expect(await collect(from('not json\n{"a":1}\n'))).toEqual([
      { ok: false, raw: 'not json' },
      { ok: true, value: { a: 1 } },
    ]);
  });

  it('keeps reading after a malformed line', async () => {
    const out = await collect(from('garbage\n{"a":1}\nmore garbage\n{"a":2}\n'));
    expect(out.filter((l) => l.ok)).toHaveLength(2);
  });

  it('accepts Buffer chunks', async () => {
    expect(await collect(from(Buffer.from('{"a":1}\n')))).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it('handles a multi-byte character split mid-sequence across chunks', async () => {
    // '{"a":"' is 6 bytes; the next character is 3 bytes, so byte 7 lands
    // INSIDE it. Naive chunk.toString('utf8') corrupts this into replacement
    // characters and the JSON either breaks or silently loses the text.
    const buf = Buffer.from('{"a":"日本語"}\n', 'utf8');
    expect(await collect(from(buf.subarray(0, 7), buf.subarray(7)))).toEqual([
      { ok: true, value: { a: '日本語' } },
    ]);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(from())).toEqual([]);
  });
});
