import { describe, expect, it } from 'vitest';
import { checkScope } from './scope.js';

describe('checkScope', () => {
  it('accepts paths inside a directory scope', () => {
    expect(checkScope(['src/a/x.ts', 'src/a/deep/y.ts'], ['src/a/'])).toEqual({ ok: true, violations: [] });
  });
  it('rejects a sibling directory with a shared prefix', () => {
    expect(checkScope(['src/ab/x.ts'], ['src/a/']).ok).toBe(false);
  });
  it('accepts an exact file scope', () => {
    expect(checkScope(['src/a.ts'], ['src/a.ts']).ok).toBe(true);
  });
  it('reports every violation, not just the first', () => {
    expect(checkScope(['x.ts', 'y.ts'], ['src/']).violations).toEqual(['x.ts', 'y.ts']);
  });
  it('accepts an empty change set', () => {
    expect(checkScope([], ['src/'])).toEqual({ ok: true, violations: [] });
  });
  it('rejects everything when the scope is empty', () => {
    expect(checkScope(['x.ts'], []).ok).toBe(false);
  });
});
