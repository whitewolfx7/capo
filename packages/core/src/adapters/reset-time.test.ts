import { describe, expect, it } from 'vitest';
import { parseResetAt } from './reset-time.js';

const NOON_UTC = new Date('2026-09-12T12:00:00.000Z');

describe('parseResetAt', () => {
  it('resolves a pm time later the same day', () => {
    expect(parseResetAt('Your limit will reset at 3pm (UTC).', NOON_UTC))
      .toBe('2026-09-12T15:00:00.000Z');
  });

  it('rolls to tomorrow when the time has already passed today', () => {
    expect(parseResetAt('Your limit will reset at 9am (UTC).', NOON_UTC))
      .toBe('2026-09-13T09:00:00.000Z');
  });

  it('handles minutes', () => {
    expect(parseResetAt('reset at 3:30pm (UTC)', NOON_UTC))
      .toBe('2026-09-12T15:30:00.000Z');
  });

  it('handles 24-hour clock', () => {
    expect(parseResetAt('reset at 18:45 UTC', NOON_UTC))
      .toBe('2026-09-12T18:45:00.000Z');
  });

  it('handles 12am as midnight', () => {
    expect(parseResetAt('reset at 12am (UTC)', NOON_UTC))
      .toBe('2026-09-13T00:00:00.000Z');
  });

  it('handles 12pm as noon, rolling forward when now is exactly noon', () => {
    expect(parseResetAt('reset at 12pm (UTC)', NOON_UTC))
      .toBe('2026-09-13T12:00:00.000Z');
  });

  it('passes an explicit ISO timestamp straight through', () => {
    expect(parseResetAt('Rate limited until 2026-09-12T18:00:00Z.', NOON_UTC))
      .toBe('2026-09-12T18:00:00.000Z');
  });

  it('accepts an ISO timestamp with a numeric offset', () => {
    expect(parseResetAt('resets at 2026-09-12T20:00:00+02:00', NOON_UTC))
      .toBe('2026-09-12T18:00:00.000Z');
  });

  it('every returned value is a valid date', () => {
    for (const s of ['reset at 3pm (UTC)', 'reset at 18:45 UTC', 'resets at 1am (UTC)']) {
      const out = parseResetAt(s, NOON_UTC);
      expect(out, s).toBeDefined();
      expect(Number.isNaN(new Date(out!).getTime()), s).toBe(false);
    }
  });

  it('returns undefined rather than guessing when there is no time', () => {
    expect(parseResetAt('Claude usage limit reached.', NOON_UTC)).toBeUndefined();
    expect(parseResetAt('You are out of quota.', NOON_UTC)).toBeUndefined();
    expect(parseResetAt('reset at some point soon', NOON_UTC)).toBeUndefined();
  });

  it('returns undefined for an impossible clock reading', () => {
    expect(parseResetAt('reset at 25:00 UTC', NOON_UTC)).toBeUndefined();
    expect(parseResetAt('reset at 13pm (UTC)', NOON_UTC)).toBeUndefined();
  });

  it('never returns a string that parses to Invalid Date', () => {
    const inputs = [
      'Claude usage limit reached. Your limit will reset at 3pm (UTC).',
      'reset at 9am', 'reset at noon', 'reset at 0:00 UTC', 'nonsense',
      '', 'reset at ', 'reset at 99:99 UTC',
    ];
    for (const s of inputs) {
      const out = parseResetAt(s, NOON_UTC);
      if (out !== undefined) {
        expect(Number.isNaN(new Date(out).getTime()), `${s} -> ${out}`).toBe(false);
      }
    }
  });
});
