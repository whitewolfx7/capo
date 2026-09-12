/**
 * `capo doctor [--json]`
 *
 * A preflight check, entirely local: Node's own version, `git --version`,
 * each platform adapter's own `doctor()` (which each probe their CLI's
 * `--version`, never the network), and whether `.capo` can be created and
 * written to under the current directory. Exits 1 if anything is not ok.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ClaudeAdapter, CodexAdapter, capoDir } from '@capo/core';
import type { DoctorResult } from '@capo/core';
import type { Io } from '../io.js';

const execFile = promisify(execFileCb);

export interface DoctorReport {
  ok: boolean;
  node: DoctorResult;
  git: DoctorResult;
  capo: DoctorResult;
  platforms: Record<string, DoctorResult>;
}

export interface DoctorOpts {
  json: boolean;
}

export async function runDoctor(opts: DoctorOpts, io: Io): Promise<number> {
  const workspace = process.cwd();

  const [node, git, capo, claudeCode, codex] = await Promise.all([
    checkNode(),
    checkGit(),
    checkCapoWritable(workspace),
    new ClaudeAdapter().doctor(),
    new CodexAdapter().doctor(),
  ]);

  const platforms: Record<string, DoctorResult> = { 'claude-code': claudeCode, codex };

  const report: DoctorReport = {
    ok: node.ok && git.ok && capo.ok && Object.values(platforms).every((p) => p.ok),
    node,
    git,
    capo,
    platforms,
  };

  if (opts.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(`node:           ${fmt(node)}`);
    io.out(`git:            ${fmt(git)}`);
    io.out(`.capo writable: ${fmt(capo)}`);
    for (const [id, result] of Object.entries(platforms)) {
      io.out(`${id.padEnd(15)} ${fmt(result)}`);
    }
  }

  return report.ok ? 0 : 1;
}

function checkNode(): DoctorResult {
  const version = process.version;
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major >= 20) {
    return { ok: true, version, problems: [] };
  }
  return { ok: false, version, problems: [`Node ${version} is below the required >=20.0.0`] };
}

async function checkGit(): Promise<DoctorResult> {
  try {
    const { stdout } = await execFile('git', ['--version'], { timeout: 10_000 });
    const version = stdout.trim();
    if (version.length === 0) {
      return { ok: false, problems: ['`git --version` printed nothing'] };
    }

    // An identity is not needed until a run integrates, which is after every
    // session has finished its work. Checking it here means a machine without
    // one finds out before it spends anything, not after.
    try {
      await execFile('git', ['var', 'GIT_COMMITTER_IDENT'], { timeout: 10_000 });
    } catch {
      return {
        ok: false,
        version,
        problems: [
          'git has no author identity configured, so CAPO could not commit or integrate. ' +
            'Set one with: git config --global user.email "you@example.com" && ' +
            'git config --global user.name "Your Name"',
        ],
      };
    }

    return { ok: true, version, problems: [] };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, problems: [`could not run \`git --version\`: ${detail}`] };
  }
}

async function checkCapoWritable(workspace: string): Promise<DoctorResult> {
  const dir = capoDir(workspace);
  const probe = join(dir, `.doctor-probe-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, 'ok', 'utf8');
    await rm(probe, { force: true });
    return { ok: true, problems: [] };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, problems: [`${dir} is not writable: ${detail}`] };
  }
}

function fmt(r: DoctorResult): string {
  const status = r.ok ? 'ok' : 'PROBLEM';
  const version = r.version ? ` (${r.version})` : '';
  const problems = r.problems.length > 0 ? ` -- ${r.problems.join('; ')}` : '';
  return `${status}${version}${problems}`;
}
