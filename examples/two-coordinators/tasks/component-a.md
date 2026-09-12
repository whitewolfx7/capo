# Task: component-a

Fix `src/component-a/add.mjs`. `add(a, b)` should return the sum of its two
arguments; right now it does not, and `src/component-a/add.test.mjs` fails
because of it.

Write scope: `src/component-a/` only. Do not touch `src/component-b/`.

Done means: `node --test 'src/component-a/**/*.test.mjs'` passes, and your
fix is committed in your task worktree.
