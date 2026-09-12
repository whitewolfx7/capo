import type { Checkpoint } from '../types.js';

export { parseCheckpoint } from './parse.js';

const NONE_LINE = '_none_';

function renderList(items: string[]): string {
  if (items.length === 0) return NONE_LINE;
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * Render a Checkpoint as the documented human-readable Markdown format.
 * A person must be able to read it, edit it, and paste it into a chat window.
 */
export function renderCheckpoint(cp: Checkpoint): string {
  const lines: string[] = [];

  lines.push(`# Checkpoint: ${cp.sessionId}`);
  lines.push(`run: ${cp.runId}`);
  lines.push(`role: ${cp.role}`);
  lines.push(`platform: ${cp.platform}`);
  lines.push(`written: ${cp.written}`);
  lines.push(`base_commit: ${cp.baseCommit}`);
  lines.push('');

  lines.push('## Objective');
  lines.push(cp.objective);
  lines.push('');

  lines.push('## Decisions made');
  lines.push(renderList(cp.decisions));
  lines.push('');

  lines.push('## Done');
  lines.push(renderList(cp.done));
  lines.push('');

  lines.push('## In progress');
  lines.push(renderList(cp.inProgress));
  lines.push('');

  lines.push('## Remaining');
  lines.push(renderList(cp.remaining));
  lines.push('');

  lines.push('## Blockers and open questions');
  lines.push(renderList(cp.blockers));

  if (cp.taskTable !== undefined) {
    lines.push('');
    lines.push('## Tasks');
    lines.push('```json');
    lines.push(JSON.stringify(cp.taskTable, null, 2));
    lines.push('```');
  }

  return lines.join('\n');
}
