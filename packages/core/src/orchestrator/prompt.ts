/**
 * Builds the system prompt handed to a session at launch, and the small
 * request/response protocol CAPO uses to pull a checkpoint out of a live
 * session before a platform switch.
 */
import { readFileSync } from 'node:fs';
import type { CapoConfig, Checkpoint, PlatformId, RoleName, SessionId } from '../types.js';
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
  /**
   * The platform this session is launching on (a key of `config.platforms`,
   * e.g. "claude" or "codex").
   *
   * Only used to build a coordinator's worker-delegation section: CAPO never
   * launches a worker itself, so the only way it can act on `config.roles.worker`
   * and `config.models.worker` at all is by handing them to the coordinator
   * that will spawn workers, and picking the right entry out of
   * `config.models.worker` needs to know which platform that is. Optional so
   * existing callers keep compiling; omitting it (or passing a non-coordinator
   * role) just skips that one section -- every other section is unaffected.
   */
  platform?: PlatformId;
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
  const { config, role, sessionId, contextFiles, roleInstructions, checkpoint, platform } = input;
  const sections: string[] = [];

  const objectiveBody = readFileSync(config.objective, 'utf8').trim();
  sections.push(`## Objective\n${objectiveBody}`);

  sections.push(`## Role instructions\n${roleInstructions.trim()}`);

  for (const file of contextFiles) {
    sections.push(`## ${file.path}\n${file.body.trim()}`);
  }

  sections.push(`## Your ownership\n${renderOwnership(config, role, sessionId)}`);

  if (role === 'coordinator' && platform !== undefined) {
    sections.push(renderWorkerDelegation(config, platform));
  }

  if (checkpoint) {
    // Fenced, not inlined. The checkpoint carries its own `##` headings, and
    // bare they collide with this prompt's section structure: the reader sees
    // "## Objective" twice meaning two different things, and the checkpoint's
    // sections merge visually into the prompt's. A fence makes the boundary
    // unambiguous, and matches the shape the session was asked to produce.
    sections.push(
      [
        '## Your checkpoint from the previous platform',
        'This is where you left off. Continue from it. You are on a different',
        'platform now and have no memory of the previous session beyond this.',
        '',
        '```markdown',
        renderCheckpoint(checkpoint).trimEnd(),
        '```',
      ].join('\n'),
    );
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

/**
 * The one place `config.roles.worker` and `config.models.worker` are ever
 * read. CAPO does not spawn workers -- a coordinator does, through its
 * host's native subagent mechanism -- so this is also the only lever CAPO
 * has on what a worker is told and which model it runs as: brief the
 * coordinator, and ask it to pass both along when it spawns one.
 *
 * Deliberately honest rather than reassuring: CAPO cannot make a platform
 * honor a model request for a subagent it doesn't launch, so the text says
 * "ask", not "set" or "use".
 */
function renderWorkerDelegation(config: CapoConfig, platform: PlatformId): string {
  const workerInstructions = readFileSync(config.roles.worker, 'utf8').trim();
  const workerModel = config.models.worker[platform];

  const lines: string[] = [];
  lines.push('## Delegating to workers');
  lines.push(
    "You spawn workers yourself, using your host's native subagent mechanism " +
      "(the Agent tool in Claude Code, Codex's own subagent support). CAPO does " +
      'not spawn workers and has no way to launch or control one directly -- this ' +
      'section is the only way it can reach a worker at all: by handing you what ' +
      'a worker should be told and asking you to pass it on.',
  );
  lines.push('');
  lines.push(
    'Brief every worker you spawn with the role instructions below, adapted to ' +
      'the specific piece of work you are delegating and to the write scope you ' +
      'are handing it (a subset of your own, inside your worktree). They describe ' +
      'what a worker owns, how it should work, and how it reports back to you:',
  );
  lines.push('');
  lines.push('### Worker role instructions');
  lines.push(workerInstructions);

  if (workerModel !== undefined) {
    lines.push('');
    lines.push(
      `When you spawn a worker, ask your subagent tooling for the "${workerModel}" ` +
        "model -- that is what this run's config designates for workers on this " +
        'platform. Treat this as a request, not a guarantee: CAPO does not launch ' +
        "the worker itself, so it cannot enforce the platform's model choice, only " +
        'ask for it through you. If your tooling has no way to request a model, or ' +
        'ignores the request, proceed anyway rather than blocking the work on it.',
    );
  }

  return lines.join('\n');
}
