#!/usr/bin/env node
/**
 * Replays a captured real `codex exec --json` stream verbatim.
 *
 * Used by `codex-real-stream.test.ts` so the adapter is exercised against
 * bytes an actual codex-cli produced, not against shapes we invented.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
process.stdout.write(readFileSync(file, 'utf8'));
process.exit(0);
