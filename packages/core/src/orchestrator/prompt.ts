/**
 * Builds the system prompt handed to a session at launch, and the small
 * request/response protocol CAPO uses to pull a checkpoint out of a live
 * session before a platform switch.
 */
import { readFileSync } from 'node:fs';
import type { CapoConfig, Checkpoint, RoleName, SessionId } from '../types.js';
import { renderCheckpoint } from '../checkpoint/render.js';

/**
 * Sent verbatim to a session to ask it to checkpoint. The session must reply
 * with nothing else: a single fenced ```markdown block, whose first line is
 * `# Checkpoint: <its own session id>`, in the documented checkpoint format
 * (see docs/architecture.md, "Checkpoints").
 */
export const CHECKPOINT_REQUEST = [
  'CAPO is pausing this run to switch platforms.',
  'Reply with nothing else: a single fenced ```markdown code block containing your checkpoint,',
  'in the documented checkpoint format, whose first line is exactly:',
  '# Checkpoint: <your own session id>',
  'Do not write anything before or after the fenced block.',
].join('\n');

/**
 * Pulls the first fenced code block out of `text` whose first line starts
 * with `# Checkpoint:`, and returns its body (without the surrounding
 * fence). Returns undefined if no such block is present.
 */
export function extractCheckpoint(text: string): string | undefined {
  const fenceRe = /```[^\n`]*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const body = match[1];
    if (body !== undefined && body.startsWith('# Checkpoint:')) {
      return body;
    }
  }
  return undefined;
}

export interface BuildSystemPromptInput {
  config: CapoConfig;
  role: RoleName;
  sessionId: SessionId;
  /** Shared context files, already read from disk. */
  contextFiles: { path: string; body: string }[];
  /** This role's instructions file, already read from disk. */
  roleInstructions: string;
  /** Present only when relaunching after a platform switch. */
  checkpoint?: Checkpoint;
}

/**
 * Concatenates, with `##` headings between them: the run objective, the role
 * instructions, the shared context files, this session's ownership
 * boundaries, and -- only when resuming -- the rendered checkpoint under
 * `## Your checkpoint from the previous platform`.
 *
 * A relaunched session gets its own checkpoint and no other session's, and
 * never the previous platform's transcript: the only history it has is
 * whatever is passed in as `checkpoint`.
 */
export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const { config, role, sessionId, contextFiles, roleInstructions, checkpoint } = input;
  const sections: string[] = [];

  const objectiveBody = readFileSync(config.objective, 'utf8').trim();
  sections.push(`## Objective\n${objectiveBody}`);

  sections.push(`## Role instructions\n${roleInstructions.trim()}`);

  for (const file of contextFiles) {
    sections.push(`## ${file.path}\n${file.body.trim()}`);
  }

  sections.push(`## Your ownership\n${renderOwnership(config, role, sessionId)}`);

  if (checkpoint) {
    sections.push(`## Your checkpoint from the previous platform\n${renderCheckpoint(checkpoint)}`);
  }

  return sections.join('\n\n');
}

function renderOwnership(config: CapoConfig, role: RoleName, sessionId: SessionId): string {
  const lines: string[] = [];
  lines.push(`You are the "${role}" session identified as "${sessionId}" in this run.`);

  if (role === 'root') {
    lines.push('You own the whole task table and every coordinator. Current tasks:');
    if (config.tasks.length === 0) {
      lines.push('- (no tasks declared; decompose the objective yourself)');
    }
    for (const task of config.tasks) {
      lines.push(
        `- ${task.id} (coordinator: ${task.coordinator}), write scope: ${task.writeScope.join(', ') || '(none)'}`,
      );
    }
  } else {
    const own = config.tasks.filter((t) => t.coordinator === sessionId);
    lines.push('You own only the following tasks, and may only write inside their scopes:');
    if (own.length === 0) {
      lines.push('- (no tasks currently assigned)');
    }
    for (const task of own) {
      lines.push(`- ${task.id}, write scope: ${task.writeScope.join(', ') || '(none)'}`);
    }
  }

  lines.push('');
  lines.push(
    'Checkpoint protocol: when CAPO sends you the message below, reply with nothing but the fenced checkpoint block it asks for. This is how your work survives a platform switch.',
  );
  lines.push('---');
  lines.push(CHECKPOINT_REQUEST);

  return lines.join('\n');
}
