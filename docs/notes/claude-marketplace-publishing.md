# Publishing CAPO to a Claude Code plugin marketplace

Status as of this pass: manifests are in shape, `claude plugin validate
--strict` passes clean on both the marketplace and the plugin. Nothing was
submitted anywhere. This file records what the source guide claimed, what
turned out to be true against the real `claude` CLI, what changed, and the
exact steps a human still has to do.

## Sources consulted

1. `https://systemprompt.io/guides/publish-plugin-claude-marketplace` — the
   guide the task pointed at. Third-party, not an Anthropic property.
2. The local `claude` CLI's own behavior: `claude plugin --help`,
   `claude plugin validate --help`, `claude plugin marketplace --help`, and
   empirical tests of `claude plugin validate --strict` against deliberately
   varied manifests in a scratch directory (not this repo).
3. Anthropic's own docs, fetched for cross-check:
   `https://code.claude.com/docs/en/plugin-marketplaces` and
   `https://code.claude.com/docs/en/plugins-reference` (the
   `docs.claude.com` guide URL 301-redirects to `code.claude.com` now).

Where the guide and the CLI disagreed, the CLI and Anthropic's own docs won.
That happened on several points below — the guide is either stale or
describes a hypothetical/aspirational workflow, not what the current CLI (an
install of Claude Code 2.1.236) actually implements.

## What the guide claimed, and what's actually true

| Guide claim | Reality (checked against CLI + official docs) |
|---|---|
| `plugin.json` needs `icon`, `categories` (array), `screenshots` fields | **False.** `claude plugin validate --strict` reports all three as unrecognized fields on `plugin.json` ("commonly seen in a VS Code/Cursor extension manifest"). They are not part of the Claude Code plugin schema at all — not on `plugin.json`, not on a marketplace plugin entry. |
| Marketplace plugin entries take `category`/`keywords` etc. | **True**, but the field is singular `category` (a plain string), not `categories`. Confirmed both empirically (`--strict` accepts `category` on a marketplace entry with no warning, and explicitly rejects `category` when it appears in `plugin.json` instead, saying it belongs in the marketplace entry) and in Anthropic's plugin-marketplaces reference, which lists `category: string` under "Optional Plugin Fields - Standard Metadata". |
| Plugin directory structure requires `commands/`, `hooks/` etc. at the top level, README.md and CHANGELOG.md are "required" | Directory conventions are correct in shape (only `plugin.json` goes inside `.claude-plugin/`), but README/CHANGELOG "requirements" are the guide's own submission-review criteria, not something `claude plugin validate` checks or enforces. CAPO's plugin has no README/CHANGELOG inside `plugins/claude/capo/`; the repo-root `README.md` covers this and per the task's hard rules is off-limits to touch here anyway. |
| Submission is via `https://clau.de/plugin-directory-submission`, a form, reviewed, then listed under `external_plugins/` in an "official repository" | **Not corroborated.** Anthropic's own `plugin-marketplaces` and `plugins-reference` docs describe how to **create and host your own marketplace** (exactly what CAPO already does) and say nothing about a submission form, a review process, an `external_plugins/` directory, or any centrally curated marketplace. I did not find any first-party confirmation of this flow. Treat the guide's submission-process section as unverified at best; it may describe a program that doesn't exist, existed and was retired, or is planned but undocumented. **Do not treat `clau.de/plugin-directory-submission` as a real destination without the owner independently confirming it resolves to something legitimate** — this pass did not visit it. |
| `marketplace.json` needs `name`, `description`, `plugins[]` at the top level (guide's minimal example) | Directionally right but incomplete — see the real schema below. The guide's example marketplace.json omits the required `owner` object entirely, which the actual CLI requires. |

## The real schema (verified)

Confirmed by testing `claude plugin validate --strict` against edited copies
of the manifests (in a scratch directory, never against this repo's git
state) and cross-checked against `code.claude.com/docs/en/plugin-marketplaces`
and `code.claude.com/docs/en/plugins-reference`.

**`plugin.json`** — only `name` is strictly required. Recognized optional
fields relevant here: `displayName`, `version`, `description`, `author`
(`name` required, `email`/`url` optional), `homepage`, `repository`,
`license`, `keywords`, plus the component pointers (`skills`, `commands`,
`agents`, `hooks`, `mcpServers`, etc. — CAPO doesn't need these since its
`skills/` directory is picked up by the default scan). `category` does
**not** belong here.

**`marketplace.json`** top level — required: `name`, `owner` (`name`
required, `email`/`url` optional), `plugins` (array). Optional: `$schema`,
`description`, `version`, `metadata.pluginRoot`,
`allowCrossMarketplaceDependenciesOn`, `renames`.

**Each entry in `plugins[]`** — required: `name`, `source`. Optional
standard metadata: `displayName`, `description`, `version`, `author`,
`homepage`, `repository`, `license`, `keywords`, `metadata` (free-form,
ignored), `category` (string), `tags` (array), `strict`, `relevance`,
`defaultEnabled`.

## What changed in this pass

- `plugins/claude/capo/.claude-plugin/plugin.json`: added `displayName`
  (`"CAPO"`), `author.url`, `homepage`, `repository` (both pointing at
  `https://github.com/whitewolfx7/capo`), and two more `keywords`
  (`claude-code`, `failover`). `name`, `version`, `description`, `license`
  were already present and correct.
- `.claude-plugin/marketplace.json`: added `owner.url`. **Moved
  `description` and `version` out of a nested `metadata` object up to the
  marketplace's top level.** This was a real, functional gap, not just a
  style nit: `metadata` is a free-form field Claude Code never reads (per
  the official reference), so the previous file's marketplace-level
  description and version were inert — `claude plugin validate` passed
  either way because unread fields don't warn, but the top-level
  `description`/`version` fields the schema actually defines were simply
  absent. Also added, to the `capo` plugin entry: `category: "orchestration"`,
  matching `keywords`, `author`, `homepage`, `repository`, `license` — so the
  marketplace entry is self-describing without needing to resolve
  `plugin.json` first.
- `docs/installation-claude.md`: added an "Option A: install from GitHub (no
  clone required)" path (`claude plugin marketplace add whitewolfx7/capo`)
  ahead of the existing local-clone path, now labeled "Option B". Updated the
  "Verified" section to be explicit about which path was actually exercised
  on this machine (the local clone) versus which is documented from CLI
  `--help` text but not executed (the GitHub-direct path).

Nothing under `plugins/codex/**`, `.agents/**`, `packages/**`,
`docs/installation-codex.md`, `README.md`, or `package.json` was touched. No
`git` command was run against this repo.

## Verified vs. assumed

**Verified directly, on this machine, with the real CLI:**
- `claude plugin validate /Users/vrl/Desktop/CAPO --strict` — passes, zero
  warnings, after the changes above.
- `claude plugin validate /Users/vrl/Desktop/CAPO/plugins/claude/capo --strict`
  — passes, zero warnings, after the changes above.
- `npx vitest run tests/plugins/` — 16/16 tests pass after the manifest
  changes.
- The exact set of fields `claude plugin validate --strict` accepts vs. flags
  on both `plugin.json` and a marketplace plugin entry (see table above) —
  established by editing scratch copies of the manifests and re-running
  `validate --strict` after each change, not by reading documentation alone.
- `claude plugin marketplace add --help` and `claude plugin --help` output,
  read directly from this install of the CLI (Claude Code 2.1.236).

**Assumed / not executed, and why:**
- `claude plugin marketplace add whitewolfx7/capo` (the new GitHub-direct
  install path documented in `installation-claude.md`) was never run. Running
  it would add a marketplace and (with the following `install` command)
  install a plugin into a real Claude Code profile on this machine, which the
  task's hard rules explicitly forbid ("Do NOT modify the user's installed
  plugins or run `claude plugin install`/`uninstall`"). It rests on the CLI's
  own `--help` text ("Add a marketplace from a URL, path, or GitHub repo")
  plus the fact that the marketplace manifest already lives at the path the
  CLI expects (`.claude-plugin/marketplace.json` at the repo root) — but it
  has not been exercised end-to-end the way the local-clone path was.
- Whether Anthropic runs any curated/reviewed marketplace listing process at
  all (the guide's "submission form" / `external_plugins/` claim) — not
  confirmed. Anthropic's own docs describe self-hosted marketplaces only.
- Whether `clau.de/plugin-directory-submission` is a real, current URL —
  not visited, not confirmed.

## Exact remaining steps for a human to actually publish

Nothing in this pass submits, publishes, or registers anything. If the owner
decides to move forward, here is what's actually left, in order:

1. **Decide what "publish" means for CAPO**, because there is no confirmed
   Anthropic-run submission queue to plug into (see above). The realistic
   options today are:
   - **a. Publish as a self-hosted marketplace (this already works).** The
     repository at `https://github.com/whitewolfx7/capo` *is* the
     marketplace. Nothing further needs to happen for someone to run
     `claude plugin marketplace add whitewolfx7/capo` today, since the repo
     is already public and MIT-licensed and the manifests now validate
     clean. The remaining "publish" work here is announcement, not
     mechanics: post the install command somewhere people will see it
     (README — already has a quickstart; project site; Claude Code plugin
     communities/Discord/forums; a tweet/post), so people know the
     marketplace name (`capo`) and source (`whitewolfx7/capo`) to add.
   - **b. Pursue a curated/official listing, if one exists.** Before doing
     anything here, the owner should independently verify whether Anthropic
     currently runs any such program and what the real submission channel
     is — check `https://docs.claude.com` / `https://code.claude.com`
     directly, or ask in an official Anthropic/Claude Code channel, rather
     than trusting the third-party guide's URL. This pass could not confirm
     `clau.de/plugin-directory-submission` is real or current. If it turns
     out to be real: fill out that form pointing at the GitHub repo; if it
     turns out to require a PR against an Anthropic-owned repository
     instead, that PR is against a *different* repository than CAPO's own,
     is not something to prepare here, and is the owner's call entirely
     (creating it means an account interaction on that other repo, which is
     also explicitly out of scope for this pass).
2. **Tag a release**, since `claude plugin tag` exists precisely for this
   (`claude plugin tag [path]` — "Create a `{name}--v{version}` git tag for a
   plugin release, validating that plugin.json and any enclosing marketplace
   entry agree"). Recommended before any announcement: run
   `claude plugin tag plugins/claude/capo` from the repo root once ready, and
   push the resulting tag. Not run in this pass (it is a git-tagging
   operation, and this pass was told not to run any git command).
3. **Optionally register `email` on `owner`/`author`** in both manifests if
   the maintainers want a contact surface beyond the GitHub URL already
   added — currently omitted since no address was given and it's optional.
4. **If pursuing option (b) and a form does exist**, the human filling it out
   should have ready: the repository URL, the marketplace name (`capo`), a
   short and long description (already in both manifests), the license
   (MIT, already correct), and confirmation the manifests validate clean
   (`claude plugin validate . --strict` and
   `claude plugin validate plugins/claude/capo --strict`, both zero-warning
   as of this pass).

None of steps 1b, 2, or 4 were performed here. Step 1a requires no further
mechanical work — the repository already functions as a marketplace today.
