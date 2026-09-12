/**
 * Newline-delimited JSON reading, shared by the platform adapters.
 *
 * This is the ONLY code the Claude Code and Codex adapters share. They are
 * meant to diverge: sharing more is how provider-specific conditionals creep
 * into the core.
 *
 * A malformed line is yielded as `{ ok: false, raw }` rather than throwing, so
 * an adapter can decide what a given platform's noise means. A platform that
 * prints a banner, a warning, or a progress line on stdout must not be able to
 * kill a session.
 */
import { StringDecoder } from 'node:string_decoder';

export type JsonLine =
  | { ok: true; value: unknown }
  | { ok: false; raw: string };

/**
 * Splits a byte or string stream into lines and parses each as JSON.
 *
 * Handles chunk boundaries that fall mid-line, CRLF, and a final line with no
 * trailing newline. Blank lines are skipped entirely.
 */
export async function* readJsonLines(
  stream: AsyncIterable<Buffer | string>,
): AsyncIterable<JsonLine> {
  // A StringDecoder, not chunk.toString(). Stdout chunk boundaries fall at
  // arbitrary byte offsets, and toString() on a partial multi-byte sequence
  // yields replacement characters: a silent corruption of any non-ASCII text
  // an agent writes. The decoder holds the incomplete tail until the next
  // chunk completes it.
  const decoder = new StringDecoder('utf8');
  let carry = '';

  for await (const chunk of stream) {
    carry += typeof chunk === 'string' ? chunk : decoder.write(chunk);

    let nl = carry.indexOf('\n');
    while (nl !== -1) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      const parsed = parseLine(line);
      if (parsed) yield parsed;
      nl = carry.indexOf('\n');
    }
  }

  carry += decoder.end();
  const last = parseLine(carry);
  if (last) yield last;
}

function parseLine(line: string): JsonLine | undefined {
  const trimmed = line.replace(/\r$/, '').trim();
  if (trimmed === '') return undefined;
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, raw: trimmed };
  }
}
