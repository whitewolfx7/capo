/**
 * The result protocol: how a coordinator reports a finished task back to
 * CAPO. Mirrors the checkpoint protocol in `orchestrator/prompt.ts`
 * (`CHECKPOINT_REQUEST` / `extractCheckpoint`) -- a fenced Markdown block
 * with a recognisable first line, pulled out of a session's plain-text
 * output. Kept in its own file because `prompt.ts` is owned by other work in
 * flight right now.
 *
 * The one real difference from a checkpoint: CAPO never asks for a result.
 * A coordinator sends one on its own schedule, whenever a task it owns is
 * done and committed in its worktree. A real Codex agent has already been
 * shown to produce a well-formed fenced block on request for the checkpoint
 * protocol, so the same shape -- applied here without CAPO having to ask
 * first -- is a proven approach.
 *
 * `ResultSubmission` (see `integrate/merge.ts`) is the shape a result must
 * end up as. This module only gets a session as far as a `RawResultSubmission`:
 * what the session itself claims. `Orchestrator#handleResult` is what turns
 * that into a `ResultSubmission`, replacing the task id and base commit with
 * what CAPO already knows -- the same division `#stampCheckpoint` makes for
 * checkpoints, and for the same reason: a live session once returned a
 * perfectly well-formed checkpoint with every identity field left blank.
 */
import { CapoError } from '../types.js';
import type { TaskId } from '../types.js';

const HEADING_PREFIX = '# Result: ';

/**
 * Describes the fenced reply CAPO recognises. Meant to be folded into a
 * session's own instructions (role instructions or ownership section)
 * alongside the checkpoint protocol -- this module only defines the text and
 * the parser, not where it gets included.
 */
export const RESULT_PROTOCOL = [
  'When a task you own is complete and its work is committed in your task worktree,',
  'report it by replying with nothing else: a single fenced ```markdown code block,',
  'in exactly this shape:',
  '',
  '```markdown',
  '# Result: <task id>',
  'task: <task id>',
  'commit: <the commit sha in your task worktree>',
  '',
  '## Evidence',
  '(what you ran and what it showed: tests, output, anything that backs up "done")',
  '```',
  '',
  'Do not write anything before or after the fenced block. CAPO fills in every',
  'fact it already knows itself (which task this is, its base commit); only the',
  'commit sha and the evidence narrative are yours to report.',
].join('\n');

/**
 * What a session itself claims in a result block, before CAPO stamps
 * anything onto it. `taskId` is trusted only when CAPO cannot resolve the
 * task another way (a coordinator owning exactly one task); `resultCommit`
 * and `evidence` are the two things only the session knows.
 */
export interface RawResultSubmission {
  taskId: TaskId;
  resultCommit: string;
  evidence: string;
}

/**
 * Pulls the first fenced code block out of `text` whose first line starts
 * with `# Result:`, and returns its body (without the surrounding fence).
 * Returns undefined if no such block is present. Mirrors `extractCheckpoint`.
 */
export function extractResult(text: string): string | undefined {
  const fenceRe = /```[^\n`]*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const body = match[1];
    if (body !== undefined && body.startsWith(HEADING_PREFIX)) {
      return body;
    }
  }
  return undefined;
}

/** Parse a `key: value` header line. Returns undefined for a line with no colon. */
function parseHeaderLine(line: string): [string, string] | undefined {
  const idx = line.indexOf(':');
  if (idx === -1) return undefined;
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

/**
 * Parses a Markdown result block (as described by `RESULT_PROTOCOL`) into a
 * `RawResultSubmission`. Throws a `CapoError` only when the block is not a
 * result at all (missing the `# Result:` heading); everything else is read
 * leniently, the same tolerance `checkpoint/parse.ts` gives a real session's
 * reply, since a missing header field or empty evidence section should never
 * crash the run.
 */
export function parseResult(markdown: string): RawResultSubmission {
  const lines = markdown.split('\n');
  const firstLine = lines[0] ?? '';
  if (!firstLine.startsWith(HEADING_PREFIX)) {
    throw new CapoError('not a result: missing "# Result:" heading');
  }
  const titleTaskId = firstLine.slice(HEADING_PREFIX.length).trim();

  const header: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || /^## /.test(line)) break;
    if (line.trim() === '') continue;
    const parsed = parseHeaderLine(line);
    if (parsed) header[parsed[0]] = parsed[1];
  }

  const rest = lines.slice(i).join('\n');
  const evidenceMatch = rest.match(/## Evidence\n?([\s\S]*)/);
  const evidence = evidenceMatch?.[1]?.trim() ?? '';

  return {
    taskId: header['task'] || titleTaskId,
    resultCommit: header['commit'] ?? '',
    evidence,
  };
}
