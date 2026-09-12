import { describe, expect, it } from 'vitest';
import { extractResult, parseResult, RESULT_PROTOCOL } from './result.js';

function block(body: string): string {
  return `some narration before\n\n\`\`\`markdown\n${body}\n\`\`\`\n\nand after`;
}

const VALID = [
  '# Result: task-a',
  'task: task-a',
  'commit: abc123',
  '',
  '## Evidence',
  '4 tests pass, ran `npm test`.',
].join('\n');

describe('extractResult', () => {
  it('pulls the fenced result block out of surrounding chatter', () => {
    const found = extractResult(block(VALID));
    expect(found).toBe(VALID);
  });

  it('returns undefined when there is no result block', () => {
    expect(extractResult('just some text\n```markdown\nnot a result\n```')).toBeUndefined();
  });

  it('ignores a checkpoint block and finds the result block after it', () => {
    const text = [
      '```markdown',
      '# Checkpoint: team-a',
      'run: r1',
      '```',
      '```markdown',
      VALID,
      '```',
    ].join('\n');
    expect(extractResult(text)).toBe(VALID);
  });
});

describe('parseResult', () => {
  it('parses task id, commit and evidence', () => {
    const raw = parseResult(VALID);
    expect(raw).toEqual({
      taskId: 'task-a',
      resultCommit: 'abc123',
      evidence: '4 tests pass, ran `npm test`.',
    });
  });

  it('falls back to the title task id when the header omits it', () => {
    const raw = parseResult(['# Result: task-b', 'commit: deadbeef', '', '## Evidence', 'ok'].join('\n'));
    expect(raw.taskId).toBe('task-b');
  });

  it('is lenient about a missing commit or empty evidence rather than throwing', () => {
    const raw = parseResult(['# Result: task-a', 'task: task-a', '', '## Evidence', ''].join('\n'));
    expect(raw.resultCommit).toBe('');
    expect(raw.evidence).toBe('');
  });

  it('throws a CapoError when the block has no "# Result:" heading', () => {
    expect(() => parseResult('# Checkpoint: team-a\nrun: r1')).toThrow(/not a result/i);
  });

  it('handles multi-line evidence', () => {
    const raw = parseResult(
      ['# Result: task-a', 'task: task-a', 'commit: sha1', '', '## Evidence', 'line one', 'line two'].join('\n'),
    );
    expect(raw.evidence).toBe('line one\nline two');
  });
});

describe('RESULT_PROTOCOL', () => {
  it('documents the exact heading a session must produce', () => {
    expect(RESULT_PROTOCOL).toContain('# Result: <task id>');
  });

  it('tells the session CAPO stamps identity itself', () => {
    expect(RESULT_PROTOCOL).toMatch(/fills in every/i);
  });
});
