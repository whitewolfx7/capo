import { CapoError } from '../types.js';
import type { Checkpoint, PlatformId, RoleName, TaskRecord } from '../types.js';

const HEADING_TITLE = '# Checkpoint: ';
const NONE_LINE = '_none_';

const SECTION_HEADINGS = {
  objective: '## Objective',
  decisions: '## Decisions made',
  done: '## Done',
  inProgress: '## In progress',
  remaining: '## Remaining',
  blockers: '## Blockers and open questions',
  tasks: '## Tasks',
} as const;

/** Parse the `key: value` header block between the title and the first `##` heading. */
function parseHeader(lines: string[]): Record<string, string> {
  const header: Record<string, string> = {};
  for (const line of lines) {
    if (line.trim() === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    header[key] = value;
  }
  return header;
}

/** Parse a list section's body: bullets starting with `- `, continuation lines joined in. */
function parseList(body: string[]): string[] {
  if (body.every((l) => l.trim() === '')) return [];
  const joined = body.join('\n').trim();
  if (joined === NONE_LINE) return [];

  const items: string[] = [];
  for (const line of body) {
    if (line.trim() === '') continue;
    if (line.startsWith('- ')) {
      items.push(line.slice(2));
    } else {
      const last = items.length > 0 ? items[items.length - 1] : undefined;
      if (last === undefined) {
        // Malformed, but be lenient: treat as a new bullet-less item.
        items.push(line);
      } else {
        items[items.length - 1] = `${last} ${line.trim()}`;
      }
    }
  }
  return items;
}

/**
 * Parse a Markdown checkpoint (as produced by renderCheckpoint) back into a
 * Checkpoint object.
 */
export function parseCheckpoint(markdown: string): Checkpoint {
  const lines = markdown.split('\n');
  const firstLine = lines[0] ?? '';
  if (!firstLine.startsWith(HEADING_TITLE)) {
    throw new CapoError('not a checkpoint: missing "# Checkpoint:" heading');
  }
  const sessionId = firstLine.slice(HEADING_TITLE.length).trim();

  // Split the remaining lines into the header block and `##`-delimited sections.
  const sections: { heading: string; body: string[] }[] = [];
  let header: Record<string, string> = {};
  let current: { heading: string; body: string[] } | undefined;
  const headerLines: string[] = [];

  for (const line of lines.slice(1)) {
    if (/^## /.test(line)) {
      if (current) sections.push(current);
      current = { heading: line.trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      headerLines.push(line);
    }
  }
  if (current) sections.push(current);
  header = parseHeader(headerLines);

  const sectionByHeading = new Map(sections.map((s) => [s.heading, s.body]));

  const getList = (heading: string): string[] => {
    const body = sectionByHeading.get(heading);
    return body ? parseList(body) : [];
  };

  const objectiveBody = sectionByHeading.get(SECTION_HEADINGS.objective) ?? [];
  const objective = objectiveBody.join('\n').trim();

  const checkpoint: Checkpoint = {
    sessionId,
    runId: header['run'] ?? '',
    role: (header['role'] ?? '') as RoleName,
    platform: (header['platform'] ?? '') as PlatformId,
    written: header['written'] ?? '',
    baseCommit: header['base_commit'] ?? '',
    objective,
    decisions: getList(SECTION_HEADINGS.decisions),
    done: getList(SECTION_HEADINGS.done),
    inProgress: getList(SECTION_HEADINGS.inProgress),
    remaining: getList(SECTION_HEADINGS.remaining),
    blockers: getList(SECTION_HEADINGS.blockers),
  };

  const tasksBody = sectionByHeading.get(SECTION_HEADINGS.tasks);
  if (tasksBody) {
    const joined = tasksBody.join('\n');
    const match = joined.match(/```json\n([\s\S]*?)\n```/);
    if (match && match[1] !== undefined) {
      checkpoint.taskTable = JSON.parse(match[1]) as TaskRecord[];
    }
  }

  return checkpoint;
}
