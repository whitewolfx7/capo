import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiply } from './multiply.mjs';

test('multiply multiplies two numbers', () => {
  assert.equal(multiply(2, 3), 6);
});
