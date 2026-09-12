import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './load.js';

let dir: string;

const VALID = `
version: 1
workspace: .
objective: ./context/GOAL.md
platforms:
  claude: { driver: claude-code }
  codex: { driver: codex }
start_on: claude
models:
  root: { claude: opus, codex: gpt-5-codex }
  coordinator: { claude: sonnet, codex: gpt-5-codex }
  worker: { claude: haiku, codex: gpt-5-codex }
roles:
  root: ./roles/root.md
  coordinator: ./roles/coordinator.md
  worker: ./roles/worker.md
context: [./context/PROJECT.md]
coordinators:
  - id: team-a
  - id: team-b
tasks:
  - id: a
    coordinator: team-a
    brief: ./tasks/a.md
    write_scope: [src/a/]
  - id: b
    coordinator: team-b
    brief: ./tasks/b.md
    write_scope: [src/b/]
limits:
  max_workers_per_coordinator: 2
`;

async function scaffold(yaml: string): Promise<string> {
  await mkdir(join(dir, 'context'), { recursive: true });
  await mkdir(join(dir, 'roles'), { recursive: true });
  await mkdir(join(dir, 'tasks'), { recursive: true });
  for (const f of ['context/GOAL.md', 'context/PROJECT.md', 'roles/root.md',
                   'roles/coordinator.md', 'roles/worker.md', 'tasks/a.md', 'tasks/b.md']) {
    await writeFile(join(dir, f), '# stub\n');
  }
  const p = join(dir, 'orchestration.yaml');
  await writeFile(p, yaml);
  return p;
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'capo-cfg-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('loadConfig', () => {
  it('loads a valid config and resolves paths to absolute', async () => {
    const cfg = await loadConfig(await scaffold(VALID));
    expect(cfg.startOn).toBe('claude');
    expect(cfg.workspace).toBe(dir);
    expect(cfg.objective).toBe(join(dir, 'context/GOAL.md'));
    expect(cfg.roles.root).toBe(join(dir, 'roles/root.md'));
    expect(cfg.tasks.map(t => t.id)).toEqual(['a', 'b']);
    expect(cfg.limits.maxWorkersPerCoordinator).toBe(2);
  });

  it('rejects start_on naming an undeclared platform', async () => {
    const p = await scaffold(VALID.replace('start_on: claude', 'start_on: gemini'));
    await expect(loadConfig(p)).rejects.toThrow(/start_on.*gemini/i);
  });

  it('rejects a role missing a model for a declared platform', async () => {
    const p = await scaffold(VALID.replace('root: { claude: opus, codex: gpt-5-codex }',
                                           'root: { claude: opus }'));
    await expect(loadConfig(p)).rejects.toThrow(/root.*codex/i);
  });

  it('rejects a task pointing at an unknown coordinator', async () => {
    const p = await scaffold(VALID.replace('coordinator: team-a', 'coordinator: team-z'));
    await expect(loadConfig(p)).rejects.toThrow(/team-z/);
  });

  it('rejects duplicate coordinator ids', async () => {
    const p = await scaffold(VALID.replace('  - id: team-b', '  - id: team-a'));
    await expect(loadConfig(p)).rejects.toThrow(/duplicate/i);
  });

  it('rejects overlapping write scopes', async () => {
    const p = await scaffold(VALID.replace('write_scope: [src/b/]', 'write_scope: [src/a/inner/]'));
    await expect(loadConfig(p)).rejects.toThrow(/overlap/i);
  });

  it('rejects a write scope escaping the workspace', async () => {
    const p = await scaffold(VALID.replace('write_scope: [src/b/]', 'write_scope: [../outside/]'));
    await expect(loadConfig(p)).rejects.toThrow(/outside the workspace/i);
  });

  it('rejects a missing referenced file', async () => {
    const p = await scaffold(VALID.replace('./roles/root.md', './roles/nope.md'));
    await expect(loadConfig(p)).rejects.toThrow(/nope\.md/);
  });

  it('allows an empty task list', async () => {
    const p = await scaffold(VALID.slice(0, VALID.indexOf('tasks:')) +
      'tasks: []\nlimits:\n  max_workers_per_coordinator: 2\n');
    const cfg = await loadConfig(p);
    expect(cfg.tasks).toEqual([]);
  });
});
