# Objective

Fix the two broken arithmetic helpers under `src/` so that the project's
tests pass:

- `src/component-a/add.mjs` — `add(a, b)` currently returns the wrong value.
- `src/component-b/multiply.mjs` — `multiply(a, b)` currently returns the
  wrong value.

Each coordinator owns exactly one component and must not touch the other's
files. When both fixes land and merge together, the combined test suite
(`node --test 'src/**/*.test.mjs'`) must pass.
