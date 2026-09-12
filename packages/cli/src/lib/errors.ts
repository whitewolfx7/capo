import { CapoError } from '@capo/core';
import type { Io } from '../io.js';

/**
 * Reports an error the way every command must: a `CapoError` prints its
 * message and its hint (when present) on stderr; anything else prints a
 * short message, never a raw stack trace, as the primary output. Always
 * returns the exit code `1` so callers can `return reportError(err, io)`.
 */
export function reportError(err: unknown, io: Io): number {
  if (err instanceof CapoError) {
    io.err(err.message);
    if (err.hint) io.err(err.hint);
    return 1;
  }
  const message = err instanceof Error ? err.message : String(err);
  io.err(`unexpected error: ${message}`);
  return 1;
}
