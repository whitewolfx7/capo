#!/usr/bin/env node
/**
 * A stand-in for the real `claude` CLI's stream-json contract, used only by
 * `claude.test.ts`. Never talks to a network or a real account.
 *
 * Behavior, in order:
 *   0. If `--version` is present, prints a version line and exits 0, so
 *      `doctor()` can be tested against the same probe it uses for real.
 *   1. Prints its own argv as a JSON array on the first stdout line, so a
 *      test can assert the exact command line the adapter built.
 *   2. Prints a `system`/`init` message carrying the `--session-id` value
 *      found in argv, so the adapter can confirm readiness against it.
 *   3. Unless `--crash` was passed (in which case it exits 1 right here,
 *      after the init line so the adapter has already seen `ready`), it
 *      reads newline-delimited JSON "user" messages from stdin. For each
 *      one it prints an `assistant` message followed by a `result` message.
 *      When the incoming text contains `__EMIT_LIMIT__` the assistant
 *      message uses the real usage-limit shape instead of an echo.
 */
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

// `doctor()` probes `--version`, the same way it does against the real CLI.
// Answer and exit before any of the stream-json behaviour below.
if (argv.includes('--version')) {
  process.stdout.write('2.1.236 (Claude Code)\n');
  process.exit(0);
}

process.stdout.write(JSON.stringify(argv) + '\n');

const sessionIdIndex = argv.indexOf('--session-id');
const sessionId = sessionIdIndex !== -1 ? argv[sessionIdIndex + 1] : 'unknown-session';

process.stdout.write(
  JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n',
);

if (argv.includes('--crash')) {
  process.exit(1);
}

function extractText(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b) => b && b.type === 'text');
  return typeof block?.text === 'string' ? block.text : undefined;
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const text = extractText(parsed) ?? '';

  if (text.includes('__EMIT_LIMIT__')) {
    process.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Claude usage limit reached. Your limit will reset at 3pm (UTC).',
            },
          ],
        },
      }) + '\n',
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `echo: ${text}` }] },
      }) + '\n',
    );
  }

  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n');
});

rl.on('close', () => {
  process.exit(0);
});
