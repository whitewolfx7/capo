## What this changes

<!-- One or two sentences. What is different after this lands? -->

## Why

<!-- The problem, not the patch. Link an issue if there is one. -->

## How it was verified

<!--
Required. "Tests pass" alone is not enough for anything touching an adapter.

This project has a specific scar: the Codex adapter once had thirteen passing
tests and could not have worked at all, because the stub encoded the same wrong
assumptions as the adapter. One live run found eight defects in code with 220
green tests. See docs/notes/codex-live-findings.md.

So if you changed an adapter, say what you observed running it against the real
CLI, and put any captured output in packages/core/src/adapters/__fixtures__/
with a test that replays it.
-->

- [ ] `npm test` passes
- [ ] `npm run typecheck` is clean
- [ ] Ran against a real platform CLI, if this touches an adapter

## Anything a reviewer should know

<!-- Known gaps, things you decided not to do, anything you are unsure about. -->
