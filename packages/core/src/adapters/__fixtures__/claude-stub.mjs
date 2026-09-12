#!/usr/bin/env node
/**
 * A stand-in for the real `claude` CLI's stream-json contract, used only by
 * `claude.test.ts`. Never talks to a network or a real account.
 *
 * Shapes here are drawn from a real captured run (Claude Code 2.1.236, see
 * `claude-real-stream.jsonl` and `claude-real-toolcall.jsonl`), not from the
 * adapter's original guesses. Two things a live run corrected are baked in
 * on purpose:
 *
 *   - `system`/`init` is re-emitted before every turn, not just the first.
 *     A live run showed this actually happens; the stub reproducing it is
 *     what makes the "only one ready event, ever" regression observable.
 *   - Usage-limit signals are a structured `rate_limit_event` with
 *     `rate_limit_info.status`, not prose in assistant text. The text-based
 *     `__EMIT_LIMIT__` trigger is kept only as a fallback-path test.
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
 *      one but the first, it first re-prints a `system`/`init` line (the
 *      real CLI does this before every turn). Then, depending on what the
 *      incoming text contains:
 *        - `__EMIT_LIMIT__`: an assistant text block using the (unconfirmed)
 *          prose usage-limit wording.
 *        - `__EMIT_RATE_LIMIT_REJECTED__`: a `rate_limit_event` with
 *          `status: "rejected"`, the real structured limit signal.
 *        - `__EMIT_RATE_LIMIT_ALLOWED__`: a `rate_limit_event` with
 *          `status: "allowed"` (must NOT surface as a usage-limit event).
 *        - `__EMIT_ERROR_RESULT__`: a `result` with `is_error: true`.
 *        - `__EMIT_TOOL__`: an assistant `tool_use` block before the reply.
 *        - anything else: an echoed assistant text block.
 *      then a `result` message (unless the error-result trigger already
 *      emitted one).
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

function writeInit() {
  process.stdout.write(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n',
  );
}

// The real CLI emits SessionStart hook events immediately but does NOT emit
// `system`/`init` until it has received a first user message. Mirroring that
// ordering here is the whole point: the old stub emitted init unprompted, so
// every test passed while a real orchestration run deadlocked, the adapter
// waiting for init and the CLI waiting for input. Verified against
// claude 2.1.236.
process.stdout.write(
  JSON.stringify({ type: 'system', subtype: 'hook_started', session_id: sessionId }) + '\n',
);
process.stdout.write(
  JSON.stringify({ type: 'system', subtype: 'hook_response', session_id: sessionId }) + '\n',
);

// --crash-early: die before init ever arrives, the way a broken install or a
// failed auth check does. start() must reject rather than hand back a dead
// session.
if (argv.includes('--crash-early')) {
  process.exit(1);
}

function extractText(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b) => b && b.type === 'text');
  return typeof block?.text === 'string' ? block.text : undefined;
}

const rl = createInterface({ input: process.stdin, terminal: false });
let turn = 0;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  turn += 1;
  // The real CLI re-sends `system`/`init` before every turn, including the
  // The real CLI emits init only once the first user message lands, and then
  // re-emits it before every later turn. So: always, on every turn.
  writeInit();

  // --crash: die AFTER becoming ready, i.e. mid-session. That must surface as
  // an exit event on the stream, not as a thrown error.
  if (argv.includes('--crash')) {
    process.exit(1);
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
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
    return;
  }

  if (text.includes('__EMIT_RATE_LIMIT_REJECTED__')) {
    process.stdout.write(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
          rateLimitType: 'five_hour',
        },
        session_id: sessionId,
      }) + '\n',
    );
    process.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'rejected' }] },
      }) + '\n',
    );
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
    return;
  }

  if (text.includes('__EMIT_RATE_LIMIT_ALLOWED__')) {
    process.stdout.write(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: 1789263000, rateLimitType: 'five_hour' },
        session_id: sessionId,
      }) + '\n',
    );
    process.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `echo: ${text}` }] },
      }) + '\n',
    );
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
    return;
  }

  if (text.includes('__EMIT_ERROR_RESULT__')) {
    process.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'about to fail' }] },
      }) + '\n',
    );
    process.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 500,
        result: 'claude-code: the model refused the request',
      }) + '\n',
    );
    return;
  }

  if (text.includes('__EMIT_TOOL__')) {
    process.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_stub1', name: 'Bash', input: { command: 'echo hi' } }],
        },
      }) + '\n',
    );
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
    return;
  }

  process.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `echo: ${text}` }] },
    }) + '\n',
  );
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
});

rl.on('close', () => {
  process.exit(0);
});
