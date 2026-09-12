/**
 * Live, human-readable transcripts of what each session is doing.
 *
 * CAPO drives its sessions headlessly, because that is the only way to hold a
 * control channel open and ask for a checkpoint on demand. The cost is that
 * the sessions appear in no host's session list and there is no window to
 * open: you are paying for several agents to work and cannot see any of them.
 *
 * A transcript is the cheap way back. Every event a session emits is appended
 * to its own file as it arrives, so `tail -f` shows the work in real time and
 * the file is still there afterwards. Nothing reads these back; they are for
 * people, and losing one must never affect a run.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent, PlatformId, SessionId } from '../types.js';

export function transcriptDir(runDir: string): string {
  return join(runDir, 'transcripts');
}

export function transcriptPath(runDir: string, sessionId: SessionId): string {
  // Session ids come from config and are validated there, but a path
  // separator here would write outside the run directory.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(transcriptDir(runDir), `${safe}.md`);
}

/** The header written when a session starts or restarts on a platform. */
export function renderSessionHeader(
  sessionId: SessionId,
  platform: PlatformId,
  model: string,
  resumed: boolean,
): string {
  const when = new Date().toISOString();
  return [
    '',
    `## ${resumed ? 'Resumed' : 'Started'} on ${platform} (${model}) at ${when}`,
    '',
  ].join('\n');
}

/**
 * One event as a transcript line, or undefined for events not worth showing.
 *
 * Deliberately lossy: a reader wants to follow the work, not audit a protocol.
 */
export function renderEvent(event: AdapterEvent): string | undefined {
  switch (event.kind) {
    case 'text':
      return event.text.trim() === '' ? undefined : `${event.text.trimEnd()}\n`;
    case 'tool':
      return `> **tool** ${event.name}${event.detail ? `: ${event.detail}` : ''}\n`;
    case 'usage-limit':
      return [
        '',
        `> **USAGE LIMIT** at ${new Date().toISOString()}`,
        `> ${event.raw}`,
        event.resetAt ? `> resets ${event.resetAt}` : '> no reset time reported',
        '',
        '_CAPO is checkpointing this session and moving the team to the other platform._',
        '',
      ].join('\n');
    case 'error':
      return `\n> **error**${event.retryable ? ' (retryable)' : ''}: ${event.message}\n`;
    case 'turn-end':
      return '\n---\n';
    case 'exit':
      return `\n> _session process exited (code ${event.code ?? 'null'})_\n`;
    case 'ready':
      // The header already says the session started.
      return undefined;
  }
}

/**
 * Appends to a session's transcript. Never throws: a transcript is a
 * convenience and must not be able to fail a run.
 */
export async function appendTranscript(
  runDir: string,
  sessionId: SessionId,
  text: string,
): Promise<void> {
  try {
    await mkdir(transcriptDir(runDir), { recursive: true });
    await appendFile(transcriptPath(runDir, sessionId), text, 'utf8');
  } catch {
    // Intentionally ignored.
  }
}
