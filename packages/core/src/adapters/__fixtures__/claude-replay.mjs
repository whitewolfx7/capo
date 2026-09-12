#!/usr/bin/env node
/**
 * Replays a captured real `claude -p --output-format stream-json` stream
 * verbatim.
 *
 * Used by `claude-real-stream.test.ts` so the adapter is exercised against
 * bytes a real `claude` CLI produced, not against shapes the stub invented.
 * Exits immediately after writing, like `codex-replay.mjs`: this replays one
 * captured run, it does not simulate a live conversation. The adapter's own
 * stdin writes (the initial prompt) land on an already-closed pipe, which
 * the adapter already tolerates (see the `stdin.on('error', ...)` no-op in
 * `claude.ts`).
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
process.stdout.write(readFileSync(file, 'utf8'));
process.exit(0);
