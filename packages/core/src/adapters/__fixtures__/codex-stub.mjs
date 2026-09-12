/**
 * Stand-in for the real `codex` CLI, used only by codex.test.ts.
 *
 * Invoked as `node codex-stub.mjs <codex argv...>` (CodexAdapter spawns
 * `process.execPath` with this file as the first extra arg in tests, so the
 * arguments after it are exactly what a real `codex` invocation would see).
 *
 * Behavior:
 *   - `--version`            -> prints a version line and exits 0. Nothing
 *                                else is printed; this path backs doctor().
 *   - otherwise              -> prints its own argv as a JSON array on the
 *                                first stdout line (test-only introspection;
 *                                CodexAdapter recognizes and swallows this
 *                                line rather than surfacing it as an event),
 *                                then a Codex-shaped `session_configured`
 *                                event, then either:
 *                                  - a rate-limit-shaped `error` event, if
 *                                    the prompt contains __EMIT_LIMIT__, or
 *                                  - an agent_message item followed by
 *                                    turn.completed otherwise.
 *
 * Event shapes match a real capture of codex-cli 0.147.0; see
 * codex-real-stream.jsonl in this directory.
 *                                Exits 0 either way.
 *
 * Handles both invocation shapes CodexAdapter uses:
 *   exec --json -m <model> <prompt>
 *   exec resume <session-id> --json <prompt>
 * so a session id minted on the first call can be threaded back in on the
 * second, exercising the multi-turn resume path for real.
 */
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log('codex-cli 0.147.0-stub');
  process.exit(0);
}

const isResume = argv[0] === 'exec' && argv[1] === 'resume';
const sessionId = isResume ? argv[2] : `stub-session-${randomUUID()}`;

// In both invocation shapes CodexAdapter uses, the prompt is the last
// positional argument.
const prompt = argv[argv.length - 1] ?? '';

/**
 * Emits one event exactly as the real `codex exec --json` does: a flat
 * top-level object, NOT wrapped in an app-server {id, msg} envelope. Verified
 * against a real capture; see codex-real-stream.jsonl.
 */
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// First line: the stub's own argv, so the test can assert on the exact
// command line CodexAdapter built, without spawning the real binary.
process.stdout.write(`${JSON.stringify(argv)}\n`);

// The real stream opens with thread.started carrying thread_id. This is the
// event that makes a session ready; without it start() never resolves.
emit({ type: 'thread.started', thread_id: sessionId });

// Real runs emit warning-shaped error items before the turn (a clamped hook
// timeout, a model metadata miss). They must not kill the session.
emit({
  type: 'item.completed',
  item: { id: 'item_0', type: 'error', message: 'clamping SessionEnd hook timeout to 3s' },
});

emit({ type: 'turn.started' });

if (prompt.includes('__EMIT_LIMIT__')) {
  emit({
    type: 'error',
    message: 'You have hit your usage limit. Try again at 2026-09-12T18:00:00Z.',
  });
  emit({
    type: 'turn.failed',
    error: { message: 'You have hit your usage limit. Try again at 2026-09-12T18:00:00Z.' },
  });
} else {
  emit({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: `stub reply to: ${prompt}` },
  });
  emit({ type: 'turn.completed' });
}

process.exit(0);
