# Installing CAPO in Claude Code

## Prerequisites

- Node 20 or newer.
- git.
- The `claude` and `codex` CLIs, both logged in. CAPO drives them; it never
  handles your credentials.

## Build the bundle

CAPO is not published to a public marketplace yet, so install from a clone.

```bash
git clone <your fork of this repo> && cd CAPO
npm install
npm run build
npm run build:plugins
```

That writes a self-contained `plugins/claude/capo/dist/capo.mjs`. It carries
its own dependencies, so it does not need the repo's `node_modules` at run time
and does not depend on a global install.

## Install

The repository is its own marketplace. From any directory:

```bash
claude plugin marketplace add /absolute/path/to/CAPO
claude plugin install capo@capo
```

Restart or reload Claude Code if it asks you to. Then check the plugin is
there:

```bash
claude plugin validate /absolute/path/to/CAPO/plugins/claude/capo
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

## Not yet verified

These commands match the `claude plugin` surface on Claude Code 2.1.236 and the
manifest passes `claude plugin validate`. A full install from a clean machine
has not been performed. If `marketplace add` rejects the repository, check that
`.claude-plugin/marketplace.json` exists at the repository root.
