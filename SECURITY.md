# Security policy

## Reporting a vulnerability

Please report security issues privately, not as a public issue.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That opens a private thread visible only
to the maintainers.

Expect a first response within a week. This is a side project, not a funded
one, so please size your expectations accordingly and say in the report if you
have a disclosure deadline in mind.

## Supported versions

Only `main` is supported. There are no released versions to backport to yet.

## What is in scope

CAPO runs AI agents against your own source code, with your own platform
credentials, on your own machine. The interesting attack surface is:

- **Config parsing.** `orchestration.yaml` is parsed as data and validated
  before any process starts. A config that escapes its declared write scopes,
  reads outside the workspace, or causes code execution during parsing is a
  vulnerability.
- **Write-scope enforcement.** Each task declares the paths it may write.
  CAPO checks a submitted diff against that scope, including files moved out of
  it by a rename. A result that lands changes outside its approved scope and is
  still accepted is a vulnerability.
- **Command construction.** Every subprocess is spawned with an argument array,
  never a shell string. A path, model name, or session id that reaches a shell
  is a vulnerability.
- **Checkpoint and transcript paths.** A session id must not be able to write
  outside the run directory.
- **Credential handling.** CAPO holds no credentials. It relies on whatever
  login the `claude` and `codex` CLIs already have. Anything that causes a
  token, key, or account detail to be written into `.capo/`, a checkpoint, a
  transcript, or a log is a vulnerability.

## What is not in scope

- **The agents' own judgment.** CAPO orchestrates AI sessions that read and
  write code. An agent making a poor or destructive change inside its approved
  write scope is a product limitation, not a vulnerability. Run CAPO on a
  repository with committed work and review the diffs.
- **The upstream platform CLIs.** Report issues in `claude` or `codex` to their
  vendors.
- **Missing approval handling.** CAPO currently has no channel to answer an
  agent that asks for permission, so a session can stall. This is a known gap,
  documented in the README, and is tracked as a normal issue.
