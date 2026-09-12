import { describe, expect, it } from 'vitest';
import { CapoError } from './types.js';

describe('CapoError', () => {
  it('carries a hint', () => {
    const e = new CapoError('bad config', 'check version');
    expect(e.name).toBe('CapoError');
    expect(e.hint).toBe('check version');
    expect(e instanceof Error).toBe(true);
  });

  it('works without a hint', () => {
    expect(new CapoError('boom').hint).toBeUndefined();
  });
});
