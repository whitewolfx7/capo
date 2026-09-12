# Codex plugin layout

Recorded 2026-09-12 against codex-cli 0.147.0 on this machine, by reading the
CLI help and inspecting installed plugins on disk. Task 1 Step 5 of the v0.1
plan. Everything marked **verified** was observed directly; everything marked
**inferred** was not.

## Headline

**Verified: a Codex plugin can carry skills, in the same shape Claude Code
uses.** The bundled `documents` plugin ships
`skills/documents/SKILL.md`. The skills-only design for CAPO v0.1 stands, and
no MCP server is needed on either host.

## Plugin directory shape

**Verified** by inspecting `documents` and `codex-app-tools`:

```text
<plugin>/
  .codex-plugin/plugin.json     # manifest
  skills/<skill-name>/SKILL.md  # skills, same convention as Claude Code
  assets/                       # optional icons
  .mcp.json                     # OPTIONAL, only if the plugin ships MCP
```

## Manifest

**Verified** fields, from `documents/.codex-plugin/plugin.json`:

```json
{
  "name": "documents",
  "version": "26.905.11957",
  "description": "...",
  "author": { "name": "OpenAI", "email": "...", "url": "..." },
  "homepage": "...",
  "repository": "...",
  "license": "MIT",
  "keywords": ["doc", "docs"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Documents",
    "shortDescription": "...",
    "longDescription": "...",
    "category": "Productivity",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": ["Draft a project memo as a document"]
  }
}
```

`"skills": "./skills/"` is the field that registers a skills directory.
`"mcpServers": "./.mcp.json"` is the equivalent for MCP and CAPO does not use
it. `interface` drives how the plugin presents in the Codex app; `name`,
`version`, `description` and `skills` are the parts CAPO needs.

Claude Code's manifest is `.claude-plugin/plugin.json` and uses the same
`name` / `version` / `description` core, so one source tree can produce both
with a different manifest path.

## Installation

**Verified** from `codex plugin --help` and `codex plugin list`: Codex installs
from a *marketplace*, not from a plugin directory directly.

A marketplace is a directory or git repo containing
`.agents/plugins/marketplace.json`:

```json
{
  "name": "capo",
  "interface": { "displayName": "CAPO" },
  "plugins": [
    {
      "name": "capo",
      "source": { "source": "local", "path": "./plugins/codex/capo" },
      "policy": { "installation": "AVAILABLE", "authentication": "NONE" },
      "category": "Developer Tools"
    }
  ]
}
```

Then:

```bash
codex plugin marketplace add /path/to/CAPO   # local path, owner/repo[@ref], or git URL
codex plugin add capo@capo
```

`codex plugin marketplace add` accepts a local path, `owner/repo[@ref]`, an
HTTPS git URL, or an SSH git URL. So the public CAPO repository can be its own
marketplace with no separate publishing step.

**Inferred, not verified:** the exact `policy.authentication` value for a plugin
that needs no auth. `ON_INSTALL` is what the bundled plugins use, and `NONE`
above is a guess. Task 12 must confirm this by actually installing the built
bundle and checking `codex plugin list` reports it enabled.

## Consequences for the plan

1. Task 12 builds a `.agents/plugins/marketplace.json` at the repo root
   alongside the two plugin bundles. One repository serves both hosts.
2. No MCP server anywhere in v0.1, confirmed rather than assumed.
3. Task 12's acceptance step is a real local install on both hosts:
   `codex plugin marketplace add .` then `codex plugin add capo@capo`, and the
   Claude Code equivalent, followed by checking the skill is discoverable.
4. Codex also keeps a `claude-plugins-official` cache under
   `~/.codex/plugins/cache/`, which suggests cross-format tolerance. CAPO does
   not rely on that. Ship a real manifest for each host.
