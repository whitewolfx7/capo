# Publishing CAPO as a Codex plugin

Recorded 2026-09-13 against codex-cli 0.154.0 (upgraded from the 0.147.0 that
`docs/notes/codex-plugin-layout.md` was written against). That earlier note's
headline conclusions still hold — verified again here — plus new findings
from comparing CAPO against the official guide and against every bundled
Codex plugin manifest reachable on this machine.

## What the guide says

Fetched from https://developers.openai.com/plugins/build/plugins and treated
as reference documentation, not instructions. The page describes:

- A root `plugin.json` with `$schema` pointing at
  `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, plus `name`
  (kebab-case), `version`, `description`, and optional `author`, `homepage`,
  `repository`, `license`, `keywords`.
- Interface metadata nested under `extensions.com.openai.interface`, with
  `displayName`, `shortDescription`, `longDescription`, `category`,
  `capabilities` (array, e.g. `["Read", "Write"]`) as the primary fields, and
  `developerName`, `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL`,
  `defaultPrompt`, `brandColor`, `composerIcon`, `logo`, `screenshots` as
  optional ones.
- Visual assets stored under `./assets/`, referenced with `./`-prefixed
  relative paths.
- Skills auto-discovered from a `skills/` directory, each a `SKILL.md` with
  `name` and `description` frontmatter.
- Plugin hooks receive `PLUGIN_ROOT` (installed plugin root) and
  `PLUGIN_DATA` (writable data dir) as their primary environment variables,
  with `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` kept "for backward
  compatibility."
- A `marketplace.json` with a top-level `name`, `interface.displayName`, and
  a `plugins` array; each entry needs `name`, `source` (`{source: "local",
  path: "./..."}` for a local plugin), `policy.installation` (values include
  `AVAILABLE`, `INSTALLED_BY_DEFAULT`, `NOT_AVAILABLE`), `policy.authentication`
  (a timing value), and `category`.
- Publishing happens through a separate submission portal; after acceptance
  the plugin appears in "the universal directory shared by ChatGPT and
  Codex."

## Where the guide conflicts with what this machine actually runs — and what I trusted

**The guide's manifest shape does not match any plugin.json this codex-cli
actually loads.** I read the full manifest of all five OpenAI-authored
plugins bundled with the local Codex runtime (`documents`, `pdf`,
`presentations`, `spreadsheets`, `template-creator`, at
`/Users/vrl/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime/plugins/*/.codex-plugin/plugin.json`)
plus the marketplace files that list them
(`.../openai-primary-runtime/.agents/plugins/marketplace.json` and
`~/.codex/.tmp/bundled-marketplaces/openai-bundled/.agents/plugins/marketplace.json`).
Every one of them:

- Has no `$schema` field at all.
- Puts `interface` at the **top level** of `plugin.json`, not nested under
  `extensions.com.openai.interface`.
- Otherwise matches the guide's field list closely: `displayName`,
  `shortDescription`, `longDescription`, `developerName`, `category`,
  `capabilities`, `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL`,
  `defaultPrompt`, `brandColor`, `composerIcon`, `logo`, `screenshots` all
  appear, just one level shallower than the guide describes.

Per the task instructions, when the guide and the real CLI disagree, the CLI
wins. **CAPO's `plugin.json` keeps the flat, top-level `interface` object it
already had** (this is also exactly what let it install and report `installed,
enabled` in the first place — see `docs/notes/codex-plugin-layout.md`). I did
not add `$schema` or restructure into `extensions.com.openai`. My best guess
is the guide documents a newer or parallel manifest spec
(`agent-plugins.org`) that this Codex build does not require yet, but I did
not verify that guess against any changelog — flagging it as inferred, not
confirmed.

I did **not** treat the guide's list of allowed `capabilities` and `category`
values as authoritative either, since it only gave examples. Instead I
enumerated every value actually used across all 31 `plugin.json` files
reachable on this machine (bundled runtime plugins plus everything cached
under `~/.codex/plugins/cache/`):

- `capabilities`: `Interactive`, `Read`, `Write` — nothing else appears.
- `category`: `Developer Tools`, `Education & Research`, `Engineering`,
  `Productivity` — CAPO's existing `"Developer Tools"` is one of these,
  confirmed correct.

## What I changed in `plugins/codex/capo/.codex-plugin/plugin.json`

Kept the verified flat structure; added fields the guide calls out that CAPO
was missing, all additive (nothing renamed or restructured):

- `author.url`, `homepage`, `repository` — all set to
  `https://github.com/whitewolfx7/capo`, matching how every reference plugin
  pairs `author.url` with `homepage`.
- `keywords`: added `codex`, `checkpoint`, `failover` alongside the existing
  four.
- `interface.developerName`: `"CAPO contributors"` (matches `author.name`).
- `interface.capabilities`: added `Read` and `Write` alongside the existing
  `Interactive` — CAPO reads config/checkpoint files and writes checkpoint
  Markdown to `.capo/`, so both are accurate, and both are members of the
  confirmed enum above.
- `interface.defaultPrompt`: expanded from one entry to three, covering
  start/status/switch, matching the 2-3 entry pattern every reference plugin
  uses.

Not added, and why:

- `$schema`, `extensions.com.openai.*` — see conflict above; adding a nesting
  layer the CLI doesn't use would be actively wrong for this codex-cli
  version, not just unnecessary.
- `composerIcon`, `logo`, `screenshots`, `brandColor` — every reference
  plugin ships `assets/icon.png` and `assets/logo.png`, but CAPO has no
  design assets and I did not fabricate placeholder art. This is optional per
  the guide (nothing in the CLI's install/list path requires it — confirmed:
  CAPO installs and shows `installed, enabled` with no `assets/` directory at
  all) but worth doing before a real public listing. Human follow-up.
- `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL` — CAPO has no
  separate marketing site or legal pages beyond the GitHub repo itself;
  leaving these unset rather than pointing them at nothing meaningful.

`.agents/plugins/marketplace.json` needed no changes. Its shape already
matches every real marketplace.json on this machine exactly (flat `name`,
`interface.displayName`, `plugins[]` with `source`/`policy`/`category`), and
`policy.authentication: "ON_USE"` remains correct — `ON_INSTALL` and `ON_USE`
are the only two accepted values, confirmed again on 0.154.0 the same way the
prior note confirmed it on 0.147.0 (rejecting `NONE` was not re-tested, since
that would mean touching a working, already-installed config).

## The `${CLAUDE_PLUGIN_ROOT}` vs `${PLUGIN_ROOT}` question: still open, and I did not change the skill

The guide states Codex's native variable is `PLUGIN_ROOT`, with
`CLAUDE_PLUGIN_ROOT` kept only "for backward compatibility." That is a
specific, useful claim — but it is scoped to "plugin hooks" in the guide's
own text, and CAPO's skill isn't a hook, it's prose in a `SKILL.md` that an
agent turns into a `node "$VAR/dist/capo.mjs"` shell command. Whether Codex's
shell tool has either variable set in its environment when running a skill
body (as opposed to a declared lifecycle hook) is not addressed by the guide
at all.

More importantly: `tests/plugins/bundle.test.ts` (outside my allowed
edit scope, and one I must keep passing) already encodes a decision on this
exact question — a test named "keeps the Codex skill free of an unverified
plugin-root token" that asserts the skill does **not** contain the literal
token `${PLUGIN_ROOT}`, does contain `${CLAUDE_PLUGIN_ROOT}`, and does contain
the `../../dist/capo.mjs` fallback. Its comment: `${PLUGIN_ROOT}` was
"inferred from strings in the codex binary and never confirmed by an
install." That is an independent, prior investigation reaching a similar
place to what I found: `PLUGIN_ROOT` shows up in documentation/strings, but
nobody has actually seen it resolve inside a running Codex skill.

**I left `plugins/codex/capo/skills/capo/SKILL.md` unchanged.** Adding
`${PLUGIN_ROOT}` — even only as a fallback — would contradict a deliberate,
tested decision already baked into this codebase, based on evidence I cannot
improve on from here (I have no way to inspect Codex's tool-execution
environment for a *running skill invocation* from inside a Claude Code
session, only its installed-plugin-cache filesystem layout). Real bundled
Codex skills (`documents`, `pdf`, `presentations`, `spreadsheets`) sidestep
the whole question: none of their `SKILL.md` bodies reference `PLUGIN_ROOT`
or `CLAUDE_PLUGIN_ROOT` at all — they invoke scripts by relative path
(`python scripts/foo.py`) because their harness sets the working directory to
the skill folder. That's a data point in favor of CAPO's relative fallback
(`../../dist/capo.mjs`, from `skills/capo/SKILL.md`) being the actually
reliable path, and it happens to be the one thing here that's been
structurally verified: it resolves to
`.../capo/capo/0.1.0/dist/capo.mjs`, exactly where `codex plugin add`
actually placed the bundle on this machine.

**Exact human step to close this out:** in a live Codex conversation with
the CAPO skill loaded, ask it to run
`env | grep -i plugin_root` (or `echo "PLUGIN_ROOT=$PLUGIN_ROOT
CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"`) before ever invoking `capo.mjs`.
Whichever variable (if either) prints a real path is the one to make
primary; if neither does, the relative fallback is not just a fallback, it's
the only mechanism that works, and the skill's two `${CLAUDE_PLUGIN_ROOT}`
mentions should arguably be simplified away entirely in a follow-up (that
follow-up would need to touch `tests/plugins/bundle.test.ts`, which is
outside this task's file scope). I did not run this test myself: it means
spending real Codex usage, which is the resource CAPO exists to conserve, and
it isn't "read-only inspection" in the sense the task scoped me to.

## A real blocker for publishing found along the way: `dist/` is gitignored

`.gitignore` at the repo root has a bare `dist/` entry, which matches
`plugins/codex/capo/dist/` (and the Claude equivalent) at any depth, with no
negating rule anywhere in the tree (confirmed: it's the only `.gitignore` in
the repo). `codex plugin marketplace add owner/repo` or a git URL installs
directly from what's committed — it does not run `npm install` or
`npm run build:plugins` on your behalf, the same way `codex plugin add` just
copies the plugin's source directory into `~/.codex/plugins/cache/` as-is.

That means **option B in the updated `docs/installation-codex.md`
(`codex plugin marketplace add whitewolfx7/capo`) will not work today**, even
after the repository is public: a bare clone has `plugin.json` and `skills/`
but no `capo.mjs`, because the build artifact that makes the skill runnable
was never committed. This is not a Codex bug or a guide gap — it is CAPO's
own build/release process not yet producing a committed or otherwise
fetchable artifact. `.gitignore` and any CI/release pipeline are both outside
this task's allowed file list (`package.json`, and anything under
`packages/**`, are explicitly off-limits here too), so I documented this
rather than fixing it.

## Verified vs. assumed, summarized

Verified (by direct inspection or by an install already performed before this
task started, per the task's brief):

- `codex plugin marketplace add /path` + `codex plugin add capo@capo` installs
  CAPO and it reports `installed, enabled  0.1.0` on codex-cli 0.154.0.
- The flat top-level `interface` object (no `extensions.com.openai` nesting,
  no `$schema`) is what every real installed Codex plugin on this machine
  uses, and is what CAPO already had and keeps.
- `capabilities` enum is exactly `{Interactive, Read, Write}` and `category`
  includes `Developer Tools`, both confirmed by scanning all 31 reachable
  `plugin.json` files, not by guessing from the guide's examples.
- `policy.authentication` accepts only `ON_INSTALL` or `ON_USE` (from the
  prior note's real install failure on `NONE`, re-read but not re-tested
  here).
- `plugins/codex/capo/dist/` is absent from a fresh checkout because
  `.gitignore`'s `dist/` rule matches it, with no override anywhere in the
  repo.
- `npx vitest run tests/plugins/` passes (16/16) after every change in this
  task.

Assumed / inferred, not verified:

- The guide's claim that `$schema` + `extensions.com.openai.interface` is a
  real, currently-enforced schema for *some* Codex distribution channel
  (rather than aspirational or for a different consumer entirely). I did not
  find it exercised anywhere on this machine.
- The guide's claim that `PLUGIN_ROOT` is genuinely substituted for a running
  *skill* invocation (as opposed to a declared lifecycle hook, which the
  guide text specifically scopes its claim to).
- That publishing through OpenAI's plugin submission portal (mentioned but
  not detailed by the fetched page) would actually accept CAPO's manifest as
  written — I did not visit or use that portal, per the task's explicit "do
  not publish" instruction.

## Exact remaining steps for a human to actually publish CAPO

1. **Decide how the built bundle reaches the published source.** Pick one:
   add a `.gitignore` exception for `plugins/claude/capo/dist/` and
   `plugins/codex/capo/dist/` and commit built bundles (simplest, but means
   committing generated code and remembering to rebuild+recommit on every
   release); or set up CI that builds on tag and publishes a release
   artifact / release branch the marketplace can point at instead of `main`.
   Either way, this needs someone with access to `package.json`, `.gitignore`,
   and CI config — all outside this task's file scope.
2. **Push the current changes** (`.agents/plugins/marketplace.json` is
   unchanged; `plugins/codex/capo/.codex-plugin/plugin.json`,
   `docs/installation-codex.md`, this file) to
   `https://github.com/whitewolfx7/capo`. I ran no `git` commands at all, per
   the hard rule for this task — that is on the human.
3. **Settle the `PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` question for real**, per
   the exact steps above, once a live Codex conversation with the plugin
   installed is available to test in (spending a small amount of real Codex
   usage to do it).
4. **Re-verify option B** once step 1 is done: from a machine that has never
   cloned CAPO, run `codex plugin marketplace add whitewolfx7/capo` then
   `codex plugin add capo@capo`, and confirm `codex plugin list` reports
   `installed, enabled` the same way the local-clone path already does here.
5. **Optional, before or independent of a public listing:** add
   `plugins/codex/capo/assets/icon.png` and `logo.png` (and the matching
   Claude-side assets, owned by the other agent working on
   `plugins/claude/**`), and set `interface.composerIcon` /
   `interface.logo` / `interface.brandColor` to point at them. Nothing in
   this task's verification blocks on this — CAPO installs and runs without
   it — but every reference plugin ships it, so a real public listing would
   look sparse without it.
6. **Only if broad discoverability (not just direct `owner/repo` installs) is
   wanted:** use OpenAI's plugin submission portal referenced by the guide
   (not detailed here — I did not visit it) to get CAPO listed in "the
   universal directory shared by ChatGPT and Codex." This is a distinct step
   from anything in this task; no account was created and nothing was
   submitted as part of this work.
