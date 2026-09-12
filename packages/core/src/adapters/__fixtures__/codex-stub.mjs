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
 *                                  - an `agent_message` followed by a
 *                                    `task_complete` event otherwise.
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

function emit(msg) {
  process.stdout.write(`${JSON.stringify({ id: String(Math.random()), msg })}\n`);
}

// First line: the stub's own argv, so the test can assert on the exact
// command line CodexAdapter built, without spawning the real binary.
process.stdout.write(`${JSON.stringify(argv)}\n`);

emit({ type: 'session_configured', session_id: sessionId, model: 'stub-model' });

if (prompt.includes('__EMIT_LIMIT__')) {
  // Best-effort guess at a Codex-shaped rate-limit event: the exact wire
  // shape codex-cli 0.147.0 uses for a limit was not part of the verified
  // CLI surface (only the exec/resume command line was), so this is an
  // `error`-typed event whose message CodexAdapter pattern-matches on
  // "usage limit", mirroring how the Claude Code adapter is described to
  // recognize its own limit text.
  emit({
    type: 'error',
    message: 'You have hit your usage limit. Try again at 2026-09-12T18:00:00Z.',
    code: 'usage_limit_reached',
  });
} else {
  const reply = `stub reply to: ${prompt}`;
  emit({ type: 'agent_message', message: reply });
  emit({ type: 'task_complete', last_agent_message: reply });
}

process.exit(0);
