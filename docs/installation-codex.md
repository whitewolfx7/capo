# Installing CAPO in Codex

## Prerequisites

- Node 20 or newer.
- git.
- The `codex` and `claude` CLIs, both logged in. CAPO drives them; it never
  handles your credentials.

## Install option A: local clone (verified)

CAPO is not listed in any hosted plugin directory yet, so the tested path is
to build the bundle yourself and point Codex at that local checkout.

```bash
git clone https://github.com/whitewolfx7/capo.git && cd capo
npm install
npm run build
npm run build:plugins
```

That writes a self-contained `plugins/codex/capo/dist/capo.mjs`. It carries its
own dependencies, so it does not need the repo's `node_modules` at run time.

Codex installs plugins from a marketplace, and this repository is one — it
carries `.agents/plugins/marketplace.json` at its root. From any directory:

```bash
codex plugin marketplace add /absolute/path/to/capo
codex plugin add capo@capo
```

Then confirm it is installed and enabled:

```bash
codex plugin list
```

This is the option that has actually been run end to end (see **Verified**
below).

## Install option B: directly from the public repository (not yet usable)

`codex plugin marketplace add` also accepts `owner/repo`, an HTTPS git URL, or
an SSH git URL, which would let anyone install CAPO with no local clone or
build step:

```bash
codex plugin marketplace add whitewolfx7/capo
codex plugin add capo@capo
```

**This does not work today**, and it is not a Codex limitation: CAPO's own
`.gitignore` excludes `dist/` everywhere in the repo, so `plugins/codex/capo/dist/`
is never committed. A checkout of the bare GitHub repo has a `plugin.json` and a
`skills/` directory but no `capo.mjs` for the skill to run — `npm run build`
never happened. Codex's `marketplace add` and `plugin add` copy the plugin
directory as-is; neither one runs `npm install` or a build step. Until the
project ships a release process that publishes a build (either by carving a
`.gitignore` exception for the two `plugins/*/capo/dist/` directories and
committing built bundles, or by producing a release artifact/branch where they
already exist), option B stays local-clone-only in practice: clone, build, then
run this same `owner/repo` form against your own clone's remote if you want to
test it, or just use option A. See
[`docs/notes/codex-marketplace-publishing.md`](notes/codex-marketplace-publishing.md)
for the exact steps needed to make option B real.

## Check it works

In a Codex conversation, ask it to run CAPO's doctor. The skill calls the
bundled CLI, and you should see Node, git, and both platform CLIs with their
versions. If a platform line says not ok, fix it before starting a run: CAPO
exists to move work to your other platform, so both need to work.

## What the plugin is

One skill, registered through `"skills": "./skills/"` in the manifest. It
teaches the conversation to run the bundled `capo` binary: start a run, read
status, force a switch when you are near a limit, and resume. There is no MCP
server and no background service.

The conversation you install into is a control panel, not the root agent. CAPO
starts its own root session with the model your config names for it.

## Using both hosts together

Install CAPO in Claude Code as well. See
[installation-claude.md](installation-claude.md). Both plugins read the same
`.capo/` directory in your project, so a run started from one host can be
inspected and switched from the other. After a usage limit that is exactly what
you will want, since the host you started from may be the capped one.

## Uninstalling

```bash
codex plugin remove capo
codex plugin marketplace remove capo
```

Neither touches your project's `.capo/` directory or stops a running
orchestrator.

## Verified

Both commands above were run for real on codex-cli 0.154.0 and succeeded:

```
Added marketplace `capo` from /path/to/CAPO.
Added plugin `capo` from marketplace `capo`.
```

`codex plugin list` then reports `capo@capo  installed, enabled  0.1.0`, and the
installed bundle runs from its own cache directory:

```bash
node ~/.codex/plugins/cache/capo/capo/0.1.0/dist/capo.mjs doctor
```

One thing this install corrected: `policy.authentication` in the marketplace
file accepts only `ON_INSTALL` or `ON_USE`. An earlier `NONE` was rejected
outright with `unknown variant`. CAPO uses `ON_USE`, which is the honest value:
CAPO has no credentials of its own and relies on whatever login the platform
CLIs already have, so there is nothing to do at install time.

Still unconfirmed: whether `${CLAUDE_PLUGIN_ROOT}` is substituted inside a
Codex skill body. Codex accepts it as an alias and shipping plugins use it, but
if the path does not resolve, the skill also documents a relative fallback of
`../../dist/capo.mjs` from the skill file.
