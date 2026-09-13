import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { ZodError } from 'zod';
import type { CapoConfig, ConfigTask, RoleName } from '../types.js';
import { CapoError } from '../types.js';
import { configFileSchema, type ConfigFile } from './schema.js';

const ROLE_NAMES: RoleName[] = ['root', 'coordinator', 'worker'];

/**
 * Reads a config file (YAML or JSON, by extension), validates it, resolves
 * every path it contains to an absolute path against the config file's own
 * directory, and returns a frozen `CapoConfig`.
 *
 * Every error a user can cause is thrown as a `CapoError` with a `hint`.
 */
export async function loadConfig(configPath: string): Promise<CapoConfig> {
  const absConfigPath = resolve(configPath);
  const text = await readConfigFile(absConfigPath);
  const raw = parseConfigText(absConfigPath, text);
  const file = validateSchema(raw);

  validateStartOn(file);
  validateModels(file);
  const coordinatorIds = validateCoordinators(file);
  validateTasks(file, coordinatorIds);

  const configDir = dirname(absConfigPath);
  const workspace = resolve(configDir, file.workspace);
  const objective = await resolveAndCheck(configDir, file.objective);

  const roles: Record<RoleName, string> = {
    root: await resolveAndCheck(configDir, file.roles.root),
    coordinator: await resolveAndCheck(configDir, file.roles.coordinator),
    worker: await resolveAndCheck(configDir, file.roles.worker),
  };

  const context: string[] = [];
  for (const c of file.context) {
    context.push(await resolveAndCheck(configDir, c));
  }

  const tasks: ConfigTask[] = [];
  for (const t of file.tasks) {
    const brief = await resolveAndCheck(configDir, t.brief);
    tasks.push({
      id: t.id,
      coordinator: t.coordinator,
      brief,
      writeScope: t.write_scope.map((s) => normalizeWriteScope(s)),
    });
  }

  validateWriteScopes(tasks, workspace);

  const cfg: CapoConfig = {
    version: 1,
    configPath: absConfigPath,
    workspace,
    objective,
    platforms: file.platforms,
    startOn: file.start_on,
    models: file.models,
    roles,
    context,
    coordinators: file.coordinators.map((c) => ({ id: c.id })),
    tasks,
    transcripts: file.transcripts,
    stallTimeoutMs: file.stall_timeout_ms,
    autonomy: file.autonomy,
    checkCommand: file.check_command,
    setupCommand: file.setup_command,
    limits: { maxWorkersPerCoordinator: file.limits.max_workers_per_coordinator },
  };

  return Object.freeze(cfg);
}

async function readConfigFile(absConfigPath: string): Promise<string> {
  try {
    return await readFile(absConfigPath, 'utf8');
  } catch (err) {
    throw new CapoError(
      `Could not read config file at ${absConfigPath}`,
      `Check that the path exists and is readable: ${absConfigPath}`,
    );
  }
}

function parseConfigText(absConfigPath: string, text: string): unknown {
  const ext = extname(absConfigPath).toLowerCase();
  try {
    if (ext === '.yaml' || ext === '.yml') {
      return parse(text);
    }
    return JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CapoError(
      `Could not parse config file at ${absConfigPath}: ${message}`,
      'Check the file for valid YAML/JSON syntax.',
    );
  }
}

function validateSchema(raw: unknown): ConfigFile {
  try {
    return configFileSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new CapoError(
        `Config file failed validation: ${issues}`,
        'Fix the listed field(s) and try again.',
      );
    }
    throw err;
  }
}

function validateStartOn(file: ConfigFile): void {
  if (!(file.start_on in file.platforms)) {
    throw new CapoError(
      `start_on names an undeclared platform: ${file.start_on}`,
      `Add "${file.start_on}" to platforms, or change start_on to one of: ${Object.keys(file.platforms).join(', ')}.`,
    );
  }
}

function validateModels(file: ConfigFile): void {
  const platformIds = Object.keys(file.platforms);
  for (const role of ROLE_NAMES) {
    const modelsForRole = file.models[role];
    for (const platformId of platformIds) {
      if (!(platformId in modelsForRole)) {
        throw new CapoError(
          `Role "${role}" is missing a model for platform "${platformId}"`,
          `Add a "${platformId}" entry under models.${role}.`,
        );
      }
    }
  }
}

function validateCoordinators(file: ConfigFile): Set<string> {
  const seen = new Set<string>();
  for (const c of file.coordinators) {
    if (seen.has(c.id)) {
      throw new CapoError(
        `Duplicate coordinator id: ${c.id}`,
        'Coordinator ids must be unique.',
      );
    }
    seen.add(c.id);
  }
  return seen;
}

function validateTasks(file: ConfigFile, coordinatorIds: Set<string>): void {
  if (file.tasks.length === 0) {
    throw new CapoError(
      'v0.1 requires at least one task under tasks:',
      'Declare each unit of work with an id, a coordinator, a brief, and a write_scope. Root-driven decomposition is not implemented.',
    );
  }

  const seenTaskIds = new Set<string>();
  for (const t of file.tasks) {
    if (seenTaskIds.has(t.id)) {
      throw new CapoError(
        `Duplicate task id: ${t.id}`,
        'Task ids must be unique.',
      );
    }
    seenTaskIds.add(t.id);

    if (!coordinatorIds.has(t.coordinator)) {
      throw new CapoError(
        `Task "${t.id}" points at an unknown coordinator: ${t.coordinator}`,
        `Declare "${t.coordinator}" under coordinators, or fix the task's coordinator field.`,
      );
    }
  }
}

async function resolveAndCheck(configDir: string, value: string): Promise<string> {
  const abs = resolve(configDir, value);
  try {
    await stat(abs);
  } catch (err) {
    throw new CapoError(
      `Referenced file does not exist: ${abs}`,
      `Create ${abs}, or fix the path in the config file.`,
    );
  }
  return abs;
}

/** Normalizes a raw write-scope entry to a POSIX path ending in a slash. */
function normalizeWriteScope(raw: string): string {
  const posix = raw.split(sep).join('/');
  return posix.endsWith('/') ? posix : `${posix}/`;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function validateWriteScopes(tasks: ConfigTask[], workspace: string): void {
  const allScopes: { taskId: string; scope: string }[] = [];

  for (const task of tasks) {
    for (const scope of task.writeScope) {
      const resolved = resolve(workspace, scope);
      const rel = relative(workspace, resolved);
      if (rel.startsWith('..')) {
        throw new CapoError(
          `Task "${task.id}" has a write scope outside the workspace: ${scope}`,
          'Write scopes must resolve to a path inside the workspace.',
        );
      }
      allScopes.push({ taskId: task.id, scope });
    }
  }

  for (let i = 0; i < allScopes.length; i++) {
    for (let j = i + 1; j < allScopes.length; j++) {
      const a = allScopes[i];
      const b = allScopes[j];
      if (!a || !b) continue;
      if (a.taskId === b.taskId) continue;
      if (overlaps(a.scope, b.scope)) {
        throw new CapoError(
          `Write scopes overlap between task "${a.taskId}" (${a.scope}) and task "${b.taskId}" (${b.scope})`,
          'Adjust write_scope entries so no two tasks can write to the same path.',
        );
      }
    }
  }
}
