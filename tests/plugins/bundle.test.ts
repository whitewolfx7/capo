import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const HOSTS = [
  { name: 'claude', pluginDir: 'plugins/claude/capo', manifestPath: 'plugins/claude/capo/.claude-plugin/plugin.json' },
  { name: 'codex', pluginDir: 'plugins/codex/capo', manifestPath: 'plugins/codex/capo/.codex-plugin/plugin.json' },
];

const ROLE_FILES = ['root.md', 'coordinator.md', 'worker.md'];
const COMMANDS = ['run', 'status', 'switch', 'resume', 'doctor'];

function abs(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

function expectedVersion(): string {
  const rootPkg = JSON.parse(readFileSync(abs('package.json'), 'utf8')) as { version?: string };
  if (typeof rootPkg.version === 'string' && rootPkg.version.length > 0) {
    return rootPkg.version;
  }
  // The root workspace package is unversioned (it's a private monorepo
  // root, not a published package); the version of record is whatever
  // @capo/cli -- the package every bundle actually ships -- is pinned to.
  const cliPkg = JSON.parse(readFileSync(abs('packages/cli/package.json'), 'utf8')) as { version: string };
  return cliPkg.version;
}

beforeAll(() => {
  execFileSync(process.execPath, [abs('scripts/build-plugins.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
}, 60_000);

describe('plugin bundles', () => {
  const version = expectedVersion();

  it('produces a non-trivial dist/capo.mjs for both hosts', () => {
    for (const host of HOSTS) {
      const bundlePath = abs(host.pluginDir, 'dist/capo.mjs');
      expect(existsSync(bundlePath), `${bundlePath} should exist`).toBe(true);
      const { size } = statSync(bundlePath);
      expect(size, `${bundlePath} should be a real bundle, not a stub`).toBeGreaterThan(10_000);
    }
  });

  it('runs the Claude bundle and prints the package version with --version', () => {
    const output = execFileSync(
      process.execPath,
      [abs('plugins/claude/capo/dist/capo.mjs'), '--version'],
      { encoding: 'utf8' },
    ).trim();
    expect(output).toBe(version);
  });

  it('runs the Codex bundle and prints the package version with --version', () => {
    const output = execFileSync(
      process.execPath,
      [abs('plugins/codex/capo/dist/capo.mjs'), '--version'],
      { encoding: 'utf8' },
    ).trim();
    expect(output).toBe(version);
  });

  for (const host of HOSTS) {
    it(`${host.name} plugin.json parses and carries name "capo" and the current version`, () => {
      const manifest = JSON.parse(readFileSync(abs(host.manifestPath), 'utf8')) as {
        name?: string;
        version?: string;
      };
      expect(manifest.name).toBe('capo');
      expect(manifest.version).toBe(version);
    });

    it(`${host.name} SKILL.md names all five commands`, () => {
      const skillPath = abs(host.pluginDir, 'skills/capo/SKILL.md');
      expect(existsSync(skillPath), `${skillPath} should exist`).toBe(true);
      const text = readFileSync(skillPath, 'utf8');
      for (const command of COMMANDS) {
        expect(
          text.includes(`capo.mjs" ${command}`) || text.includes(`capo.mjs\` ${command}`),
          `SKILL.md for ${host.name} should document the "${command}" command`,
        ).toBe(true);
      }
    });

    it(`${host.name} bundle carries all three shared role files`, () => {
      for (const file of ROLE_FILES) {
        const roleBundlePath = abs(host.pluginDir, 'dist/roles', file);
        expect(existsSync(roleBundlePath), `${roleBundlePath} should exist`).toBe(true);
        expect(statSync(roleBundlePath).size).toBeGreaterThan(0);
      }
    });

    it(`${host.name} bundle contains no absolute path from the build machine`, () => {
      const text = readFileSync(abs(host.pluginDir, 'dist/capo.mjs'), 'utf8');
      expect(text).not.toContain(REPO_ROOT);
    });
  }

  it('the three shared role source files exist and are real content', () => {
    for (const file of ROLE_FILES) {
      const rolePath = abs('plugins/shared/roles', file);
      expect(existsSync(rolePath), `${rolePath} should exist`).toBe(true);
      expect(statSync(rolePath).size).toBeGreaterThan(200);
    }
  });

  it('the marketplace manifest parses and its listed source paths exist', () => {
    const marketplacePath = abs('.agents/plugins/marketplace.json');
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as {
      plugins: { source: { source: string; path: string } }[];
    };
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
    for (const plugin of marketplace.plugins) {
      expect(plugin.source.source).toBe('local');
      const sourcePath = abs(plugin.source.path);
      expect(existsSync(sourcePath), `${sourcePath} should exist`).toBe(true);
    }
  });
});

describe('marketplace metadata', () => {
  /**
   * The two hosts read different files in different formats and locations.
   * Shipping only one means `plugin marketplace add` fails on the other host,
   * which is the very first thing a user does.
   */
  it('ships a Codex marketplace at .agents/plugins/marketplace.json', () => {
    const mkt = JSON.parse(
      readFileSync(join(REPO_ROOT, '.agents/plugins/marketplace.json'), 'utf8'),
    ) as { name: string; plugins: { name: string; source: { path: string } }[] };
    expect(mkt.name).toBe('capo');
    const entry = mkt.plugins.find((p) => p.name === 'capo');
    expect(entry, 'a plugin named capo').toBeDefined();
    expect(existsSync(join(REPO_ROOT, entry!.source.path))).toBe(true);
    expect(entry!.source.path).toContain('plugins/codex/capo');
  });

  it('ships a Claude Code marketplace at .claude-plugin/marketplace.json', () => {
    const mkt = JSON.parse(
      readFileSync(join(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf8'),
    ) as { name: string; owner: { name: string }; plugins: { name: string; source: string }[] };
    expect(mkt.name).toBe('capo');
    expect(mkt.owner.name).toBeTruthy();
    const entry = mkt.plugins.find((p) => p.name === 'capo');
    expect(entry, 'a plugin named capo').toBeDefined();
    // Claude Code's format uses a plain string source, not Codex's object.
    expect(typeof entry!.source).toBe('string');
    expect(existsSync(join(REPO_ROOT, entry!.source))).toBe(true);
    expect(entry!.source).toContain('plugins/claude/capo');
  });

  it('keeps the Codex skill free of an unverified plugin-root token', () => {
    // ${PLUGIN_ROOT} was inferred from strings in the codex binary and never
    // confirmed by an install. Shipping plugins use ${CLAUDE_PLUGIN_ROOT},
    // which codex accepts as a compat alias, so that is what we use.
    const skill = readFileSync(
      join(REPO_ROOT, 'plugins/codex/capo/skills/capo/SKILL.md'), 'utf8',
    );
    expect(skill).not.toMatch(/\$\{PLUGIN_ROOT\}/);
    expect(skill).toContain('${CLAUDE_PLUGIN_ROOT}');
    // And a fallback that needs no substitution at all.
    expect(skill).toContain('../../dist/capo.mjs');
  });
});
