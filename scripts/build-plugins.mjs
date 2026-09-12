#!/usr/bin/env node
/**
 * Builds the self-contained plugin bundles for both hosts.
 *
 * For each of `plugins/claude/capo` and `plugins/codex/capo`, this:
 *   1. Bundles `packages/cli`'s built entry point into `dist/capo.mjs` with
 *      esbuild, `bundle: true`, `platform: 'node'`, `target: 'node20'`,
 *      `format: 'esm'`, so the plugin never depends on a development
 *      checkout or a global npm install.
 *   2. Copies the three shared role files (`plugins/shared/roles/*.md`) into
 *      `dist/roles/` inside the bundle.
 *   3. Stamps each `plugin.json`'s `version` field so it always matches the
 *      CLI it ships, instead of drifting out of sync by hand.
 *
 * Run with `npm run build:plugins`. Requires `npm run build` to have already
 * produced `packages/cli/dist/main.js` (this script does not compile
 * TypeScript itself).
 */
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/dist/main.js');
const ROLE_FILES = ['root.md', 'coordinator.md', 'worker.md'];
const ROLES_DIR = join(REPO_ROOT, 'plugins/shared/roles');

const HOSTS = [
  { name: 'claude', pluginDir: join(REPO_ROOT, 'plugins/claude/capo'), manifestDir: '.claude-plugin' },
  { name: 'codex', pluginDir: join(REPO_ROOT, 'plugins/codex/capo'), manifestDir: '.codex-plugin' },
];

function resolveVersion() {
  // The root package.json (`capo-monorepo`) is unversioned -- it is a
  // private workspace root, not a published package. The version every
  // plugin ships is the version of the package it bundles: `@capo/cli`
  // (which is pinned to the same version as `@capo/core`). Reading it here,
  // instead of hardcoding it into each plugin.json, is what keeps the
  // manifests from drifting out of sync with the CLI as it's released.
  const cliPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/cli/package.json'), 'utf8'));
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof rootPkg.version === 'string' && rootPkg.version.length > 0) {
    return rootPkg.version;
  }
  return cliPkg.version;
}

function stampManifestVersion(manifestPath, version) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function copyRoleFiles(destDir) {
  const rolesOut = join(destDir, 'roles');
  mkdirSync(rolesOut, { recursive: true });
  for (const file of ROLE_FILES) {
    copyFileSync(join(ROLES_DIR, file), join(rolesOut, file));
  }
}

async function buildHost(host, version) {
  const distDir = join(host.pluginDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  const outfile = join(distDir, 'capo.mjs');

  await build({
    entryPoints: [CLI_ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    absWorkingDir: REPO_ROOT,
    logLevel: 'silent',
    // A couple of bundled CommonJS dependencies (e.g. `yaml`) still contain
    // a handful of `require(...)` calls esbuild can't statically resolve
    // away when converting CJS to ESM output. Node's ESM has no global
    // `require`, so esbuild's own fallback shim throws at runtime. Giving
    // the bundle a real `require`, backed by `createRequire`, makes those
    // calls work exactly as they would under `platform: 'node'` CJS output,
    // without pulling in an extra dependency or leaving anything external.
    banner: {
      js: "import { createRequire as __capoCreateRequire } from 'node:module';\nconst require = __capoCreateRequire(import.meta.url);",
    },
  });

  copyRoleFiles(distDir);

  const manifestPath = join(host.pluginDir, host.manifestDir, 'plugin.json');
  stampManifestVersion(manifestPath, version);

  const { size } = statSync(outfile);
  console.log(`[build-plugins] ${host.name}: ${outfile} (${size} bytes), plugin.json version ${version}`);
}

async function main() {
  if (!existsSync(CLI_ENTRY)) {
    console.error(
      `[build-plugins] ${CLI_ENTRY} does not exist. Run "npm run build" first so packages/cli/dist exists.`,
    );
    process.exitCode = 1;
    return;
  }

  const version = resolveVersion();
  for (const host of HOSTS) {
    await buildHost(host, version);
  }
}

await main();
