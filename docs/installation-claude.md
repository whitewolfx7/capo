# Installing CAPO in Claude Code

## Prerequisites

- Node 20 or newer.
- git.
- The `claude` and `codex` CLIs, both logged in. CAPO drives them; it never
  handles your credentials.

There are two ways to install: straight from GitHub (no clone, no build step
on your side), or from a local clone (useful for development, or before the
repository is listed in any curated directory). Both add the same repository
as a marketplace and install the same `capo@capo` plugin.

## Option A: install from GitHub (no clone required)

The repository root already carries `.claude-plugin/marketplace.json`, so
Claude Code can add it as a marketplace directly from the GitHub remote —
you never need to `git clone` it yourself:

```bash
claude plugin marketplace add whitewolfx7/capo
claude plugin install capo@capo
```

`claude plugin marketplace add` also accepts a full URL
(`https://github.com/whitewolfx7/capo`) if you prefer to be explicit. Claude
Code fetches the plugin's pre-built bundle
(`plugins/claude/capo/dist/capo.mjs`) straight from the repository — there is
no separate build step to run locally.

Restart or reload Claude Code if it asks you to.

## Option B: install from a local clone

Useful if you want to build from source, track a branch, or inspect the code
before installing.

### Build the bundle

```bash
git clone https://github.com/whitewolfx7/capo.git && cd capo
npm install
npm run build
npm run build:plugins
```

That writes a self-contained `plugins/claude/capo/dist/capo.mjs`. It carries
its own dependencies, so it does not need the repo's `node_modules` at run time
and does not depend on a global install.

### Install

The clone is its own marketplace. From any directory:

```bash
claude plugin marketplace add /absolute/path/to/capo
claude plugin install capo@capo
```

Restart or reload Claude Code if it asks you to. Then check the plugin is
there:

```bash
claude plugin validate /absolute/path/to/capo/plugins/claude/capo
```

## Check it works

In a Claude Code conversation, ask it to run CAPO's doctor. The skill will call
the bundled CLI, and you should see a report naming Node, git, and both
platform CLIs with their versions. If a platform line says not ok, fix that
before starting a run: the whole point of CAPO is having a second platform to
move to.

## What the plugin is

One skill. It teaches the conversation how to run the bundled `capo` binary:
start a run from a config file, read status, force a switch when you are near a
limit, and resume. There is no MCP server and no background service.

The conversation you install into is a control panel, not the root agent. CAPO
starts its own root session with the model your config names for it. That
separation matters, because the conversation you are typing in is running on
the platform most likely to hit a limit next.

## Using both hosts together

Install CAPO in Codex as well. See
[installation-codex.md](installation-codex.md). Both plugins read the same
`.capo/` directory in your project, so you can start a run from Claude Code and
check on it from Codex. That is the expected flow rather than an edge case:
after a switch, the host you started from may be the capped one.

## Uninstalling

```bash
claude plugin uninstall capo@capo
claude plugin marketplace remove capo
```

Neither touches your project's `.capo/` directory or stops a running
orchestrator. Stop a run explicitly before uninstalling if you want it stopped.

## Verified

The **local clone** path (Option B) was run for real on Claude Code 2.1.236
and succeeded:

```
✔ Successfully added marketplace: capo (declared in user settings)
✔ Successfully installed plugin: capo@capo (scope: user)
```

The manifest also passes `claude plugin validate --strict` with zero warnings.
Not yet confirmed from a clean machine, only from this one.

The **GitHub-direct** path (Option A) has not been executed end-to-end — doing
so adds a marketplace and installs a plugin into a real Claude Code profile,
which is outside what this pass touched. It is documented here because
`claude plugin marketplace add --help` confirms the command accepts "a URL,
path, or GitHub repo" as its `<source>` argument, and the marketplace manifest
lives at the standard `.claude-plugin/marketplace.json` path the CLI expects
at the repository root. Try it and open an issue if it does not behave as
described.
