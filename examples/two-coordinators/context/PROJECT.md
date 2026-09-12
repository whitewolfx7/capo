# Project

This is a tiny, self-contained Node.js project used as CAPO's acceptance
demo. There is no build step and no dependency beyond Node's own built-in
test runner.

```text
src/
  component-a/
    add.mjs         # exports add(a, b)
    add.test.mjs     # node:test coverage for add()
  component-b/
    multiply.mjs      # exports multiply(a, b)
    multiply.test.mjs # node:test coverage for multiply()
```

Run the whole suite with:

```sh
node --test 'src/**/*.test.mjs'
```

Two coordinators work on this project at once:

- **team-a** owns `src/component-a/` only.
- **team-b** owns `src/component-b/` only.

Neither may write outside its own directory. The root integrates both
results once they are done.
