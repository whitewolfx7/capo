# Contributing to CAPO

CAPO is a small open-source side project. Issues and pull requests are welcome.

## Before you start

Read [docs/architecture.md](docs/architecture.md) for what v0.1 is, and
[docs/roadmap.md](docs/roadmap.md) for what is deliberately out of scope. A lot
of obvious-looking additions are on the roadmap on purpose.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run build:plugins
```

Everything must pass before a pull request. The suite is fast and offline: no
test may make a network call or drive a real platform CLI.

## The one rule worth stating

**A stub proves almost nothing.** The Codex adapter once had thirteen passing
tests and could not have worked at all, because the stub encoded exactly the
same wrong assumptions as the adapter. One live run found eight defects in code
with 220 green tests.

So: if you change an adapter, run it against the real CLI, and say in the pull
request what you observed. Captured real output belongs in
`packages/core/src/adapters/__fixtures__/` and should be replayed by a test.
See [docs/notes/codex-live-findings.md](docs/notes/codex-live-findings.md) for
what that process turned up.

## Style

- TypeScript, ESM, `NodeNext`. Relative imports end in `.js`.
- Runtime dependencies are limited to `yaml` and `zod`. Adding one needs a
  reason in the pull request.
- Comments should explain why, especially where the code looks odd. Most of the
  odd-looking code here is odd because something real broke.

## Reporting a security issue

Open a private security advisory on the repository rather than a public issue.
