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
import type { AdapterEvent, AutonomyLevel, PlatformId, SessionId } from '../types.js';

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
 * The notice appended when the stall watchdog marks a session silent (see
 * `Orchestrator`'s `#checkStalls`). Not an `AdapterEvent` — CAPO generates
 * this about a session, not from one — so it doesn't go through
 * `renderEvent()`.
 */
export function renderStallNotice(timeoutMs: number, autonomy?: AutonomyLevel): string {
  const seconds = Math.round(timeoutMs / 1000);
  const lines = [
    '',
    `> **STALLED** at ${new Date().toISOString()}: no events for over ${seconds}s.`,
    '> Not necessarily a problem: this session may be deep in a slow tool call,',
    '> or waiting on an answer from a human that never arrives. CAPO will not',
    '> act on this by itself — it is only visible here, in `capo status`, and',
    '> in STATUS.md so a person can decide.',
  ];
  if (autonomy === 'supervised') {
    // The observed cause of the original stall: an agent asked "approve?" and
    // waited forever, because a headless session has nobody to answer it.
    lines.push(
      '>',
      '> This run is `autonomy: supervised`, so sessions may act only in a',
      '> read-and-plan capacity and will stop to ask before writing anything.',
      '> Nobody is present to answer. If you meant this run to do work, set',
      '> `autonomy: autonomous` in the config and resume.',
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Appended once a previously stalled session starts emitting events again. */
export function renderStallClearedNotice(): string {
  return ['', `> _stall cleared at ${new Date().toISOString()}: events are flowing again._`, ''].join(
    '\n',
  );
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
