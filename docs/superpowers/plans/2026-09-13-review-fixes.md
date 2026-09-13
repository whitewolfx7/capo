# Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ten findings from the 2026-09-13 end-to-end review of CAPO v0.1 so a run cannot pollute the user's branch, survives a platform switch with a useful checkpoint, and is drivable from any directory.

**Architecture:** All changes stay inside the existing monorepo layout: `packages/core` (orchestrator, adapters, config, git, integrate) and `packages/cli` (commands, arg parsing). No new packages. The orchestrator gains four small behaviours (root read-only, checkpoint retry/skip/augment, result nudge, sha validation, stale-event guard); the adapters gain isolation flags and one more limit signal; the CLI gains workspace discovery; config gains `setup_command` and rejects empty `tasks`.

**Tech Stack:** TypeScript 7, Node 20+, vitest 5, zod 4, `FakeAdapter` for orchestrator tests, real `git` in temp dirs for integration tests.

**Spec:** The review findings are the spec. They are reproduced here in **Global Constraints** and in each task's opening paragraph. There is no separate spec document.

## Global Constraints

- Every test in `npm test` stays green after every task. Run the full suite before each commit.
- `npm run typecheck` (tsc --build --force) passes after every task.
- Never call `process.exit` from library code; the CLI `main()` returns exit codes (existing convention).
- `git` is always invoked via `execFile` with an argv array, never a shell string (existing convention in `packages/core/src/git/repo.ts`).
- Config keys are `snake_case` on the wire and `camelCase` on `CapoConfig` (existing convention in `packages/core/src/config/`).
- Adapter event kinds are fixed: `ready | text | tool | usage-limit | turn-end | error | exit` (`packages/core/src/types.ts`). Do not add kinds.
- The root session runs in the workspace and must be **unable to write** there on either platform. Claude: `--permission-mode plan`. Codex: `--sandbox read-only`.
- Coordinator sessions keep today's autonomy mapping: Claude `bypassPermissions` when `autonomous`, `plan` when `supervised`; Codex `--approve-for-me` when `autonomous`, `--sandbox read-only` when `supervised`.
- Claude sessions launch with `--setting-sources project,local` so user-scope plugins, hooks and skills are not loaded.
- A checkpoint request is sent at most twice per pause: once immediately, once more at the next `turn-end` if still unanswered. The per-session timeout stays `CHECKPOINT_TIMEOUT_MS = 60_000`.
- On pause reason `usage-limit`, sessions are **not asked** for a checkpoint at all; each gets a synthesized checkpoint augmented with git facts.
- A synthesized or model-written coordinator checkpoint is augmented from its worktree: commits since the run's base commit go under `done` as `commit <short-sha> <subject>`, uncommitted paths go under `inProgress` as `uncommitted in worktree: <paths>`.
- A coordinator whose turn ends with an owned task still `running` is nudged at most `MAX_RESULT_NUDGES = 3` times per launch with the exact text `RESULT_NUDGE` (Task 4).
- A result whose `commit` is not `/^[0-9a-f]{7,40}$/i` is ignored and logged; the task stays where it was.
- `capo status`, `capo switch`, `capo resume` all accept `--workspace <dir>`; without it they locate the workspace by walking up from `process.cwd()` to the first directory containing `.capo/runs/<run-id>` (or `.capo/runs` when no id).
- `capo switch` on a run whose status is `done` or `failed` exits 1 with `run <id> is already <status>; nothing to switch`.
- New config key `setup_command: string[]` (argv, default `[]`), run once in every coordinator worktree right after creation and once in the integration worktree after all merges and before `check_command`.
- `tasks: []` is rejected at config load with `CapoError('v0.1 requires at least one task under tasks:', ...)`.
- Commit message style: conventional prefix (`fix:`, `feat:`, `docs:`, `test:`), imperative, and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Root session is read-only on both platforms

The review (finding 1) watched the root, relaunched on Codex, call `spawn_agent` twice; both children ran with cwd set to the workspace and committed both fixes to `main`. Prompt wording has failed twice. The root must be mechanically unable to write.

**Files:**
- Modify: `packages/core/src/orchestrator/run.ts` (`#launchOne`, the `opts` literal around line 617)
- Modify: `packages/core/src/adapters/codex.ts` (`autonomyFlags`, lines 168-175, and its doc comment)
- Modify: `packages/core/src/adapters/codex.test.ts`
- Modify: `packages/core/src/orchestrator/run.test.ts`
- Modify: `plugins/shared/roles/root.md`, `examples/two-coordinators/roles/root.md`

**Interfaces:**
- Consumes: `StartSessionOptions.autonomy?: AutonomyLevel` (`packages/core/src/types.ts`).
- Produces: `FakeAdapter` records each session's `StartSessionOptions`; check `packages/core/src/adapters/fake.ts` for the field name (it keeps per-session state in `sessions`). If it does not record `opts`, add `readonly starts: StartSessionOptions[]` to `FakeAdapter`, pushed in `start()`.

- [ ] **Step 1: Write the failing orchestrator test**

In `packages/core/src/orchestrator/run.test.ts`, inside an existing `describe` that builds an `Orchestrator` with `FakeAdapter`s (copy the setup helper the file already uses), add:

```ts
it('launches the root supervised (read-only) and coordinators with the configured autonomy', async () => {
  // build config with autonomy: 'autonomous' using the file's existing helper
  // start the orchestrator
  const starts = claude.starts; // StartSessionOptions[] recorded by FakeAdapter
  const root = starts.find((s) => s.role === 'root');
  const coord = starts.find((s) => s.role === 'coordinator');
  expect(root?.autonomy).toBe('supervised');
  expect(coord?.autonomy).toBe('autonomous');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/core/src/orchestrator/run.test.ts -t "read-only"`
Expected: FAIL (root autonomy is `'autonomous'`, or `starts` is undefined).

- [ ] **Step 3: Implement in the orchestrator**

In `#launchOne`, replace `autonomy: this.#config.autonomy,` with:

```ts
// The root sits in the shared workspace. Twice now a live root has written
// there (once itself, once through spawned subagents) despite instructions
// not to. Instructions are not a boundary; a read-only launch is.
autonomy: role === 'root' ? 'supervised' : this.#config.autonomy,
```

- [ ] **Step 4: Write the failing Codex adapter test**

In `packages/core/src/adapters/codex.test.ts`, next to the existing autonomy tests:

```ts
it('passes --sandbox read-only on every turn when supervised', async () => {
  // start a session with autonomy: 'supervised' using the stub the file already uses,
  // then send() once, then inspect session.debugArgv
  expect(session.debugArgv[0]).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
  expect(session.debugArgv[1]).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
  expect(session.debugArgv[0]).not.toContain('--approve-for-me');
});
```

Update the existing test `adds no autonomy flag when autonomy is left unset` to expect `--sandbox read-only` instead of no flag (unset still means supervised).

- [ ] **Step 5: Implement in the Codex adapter**

Replace `autonomyFlags`:

```ts
function autonomyFlags(level: AutonomyLevel | undefined): string[] {
  switch (level ?? 'supervised') {
    case 'autonomous':
      return ['--approve-for-me'];
    case 'supervised':
      // Read and plan, write nothing. Not "unchanged": the README has
      // always described supervised this way, and the root relies on it.
      return ['--sandbox', 'read-only'];
  }
}
```

Update the function's doc comment so it no longer says supervised "adds nothing".

- [ ] **Step 6: Update the root role text**

In both `plugins/shared/roles/root.md` and `examples/two-coordinators/roles/root.md`, replace the paragraph starting "This is not a matter of etiquette" (shared) / add after "You do not write code" (example) with:

```markdown
You are launched read-only: on Claude Code in plan mode, on Codex with a
read-only sandbox. Any attempt to edit, commit, or spawn a subagent that
writes will fail, and that is by design. You also have no channel to the
coordinators: they report to CAPO, not to you, and nothing you write reaches
them. What you write is read by the person watching this run's transcript.
Use it to judge, in plain language, whether the reported work meets the
objective.
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A packages/core/src plugins/shared/roles examples/two-coordinators/roles
git commit -m "fix(orchestrator): launch the root read-only on both platforms"
```

---

### Task 2: Claude sessions launch without user-scope plugins, hooks and skills

Finding 2: the root loaded this machine's `capo:capo` skill and ran `capo status` on its own run; coordinators loaded `superpowers:systematic-debugging`; every turn carried ~37k tokens of user-scope system prompt. Claude Code has `--setting-sources <user,project,local>`; omitting `user` drops user-scope settings (which is where installed plugins, their skills and hooks are enabled).

**Files:**
- Modify: `packages/core/src/adapters/claude.ts` (`start()` argv, lines 320-336, and header comment)
- Modify: `packages/core/src/adapters/claude.test.ts` (the argv test)
- Modify: `README.md` ("What sessions are allowed to do" section: one paragraph)

- [ ] **Step 1: Extend the argv test**

In the test `passes model, session id and streaming flags to the child process`, add:

```ts
expect(adapter.lastArgv).toEqual(expect.arrayContaining(['--setting-sources', 'project,local']));
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/core/src/adapters/claude.test.ts -t "streaming flags"`
Expected: FAIL.

- [ ] **Step 3: Add the flag**

In `start()`'s `args` array, after the `--permission-mode` pair:

```ts
// User-scope settings are where installed plugins, their skills and
// hooks live. A live run showed the root loading CAPO's own plugin skill
// and driving `capo status` against its own run, and coordinators
// loading unrelated skills; each turn also carried ~37k tokens of that
// system prompt. Project and local settings still apply, so a project's
// own configuration is honored.
'--setting-sources',
'project,local',
```

Add a bullet to the header comment's "What the live run confirmed" list recording this.

- [ ] **Step 4: Live probe (one Haiku turn, from the worktree root)**

Run:
```bash
claude -p --model haiku --setting-sources project,local --output-format json "List the names of the skills or slash commands available to you as a comma-separated list, nothing else." | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("result:",j.result);console.log("cache_creation:",j.usage.cache_creation_input_tokens)})'
```
Record the printed `result` and `cache_creation` in your report. Expected: no `capo` or `superpowers` names, and cache_creation well below 36891 (the figure measured without the flag). If the flag is rejected or auth fails, stop and report BLOCKED with the exact error.

- [ ] **Step 5: README paragraph**

In README "What sessions are allowed to do", after the Codex sentence, add:

```markdown
Claude Code sessions are launched with `--setting-sources project,local`, so
plugins, skills and hooks installed at user scope on your machine are not
loaded into them. A live run showed a root session picking up CAPO's own
plugin skill and treating itself as the control panel. Codex has no
equivalent flag, so Codex sessions still see every plugin in
`~/.codex/config.toml`; the root's read-only sandbox is what bounds it there.
```

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A packages/core/src/adapters README.md
git commit -m "fix(claude): launch sessions without user-scope plugins and hooks"
```

---

### Task 3: Checkpoints that survive a real limit

Finding 3: team-b's checkpoint was synthesized empty although it had committed and reported; the request was injected mid-turn, the model answered with its result instead, and CAPO never re-asked. Under a real limit the capped session cannot answer at all. Three changes: augment every coordinator checkpoint with git facts from its worktree; re-send the request once at the next `turn-end`; on reason `usage-limit`, do not ask at all.

**Files:**
- Modify: `packages/core/src/git/repo.ts` (add `describeWorktree`)
- Modify: `packages/core/src/git/repo.test.ts`
- Modify: `packages/core/src/orchestrator/run.ts` (`#checkpointAndCloseAll`, `#requestCheckpoint`, `#stampCheckpoint`, `#synthesizeCheckpoint`, `#onEvent` `turn-end` case)
- Modify: `packages/core/src/orchestrator/run.test.ts`

**Interfaces:**
- Produces: `export async function describeWorktree(worktree: string, base: string): Promise<{ commits: string[]; dirty: string[] }>` in `repo.ts`. `commits` are `"<short-sha> <subject>"` oldest first for `base..HEAD`; `dirty` are the paths from `git status --porcelain` (columns 4 onward, trimmed).
- Produces: `Orchestrator` private `#checkpointResent: Set<SessionId>`.

- [ ] **Step 1: Failing test for `describeWorktree`**

In `packages/core/src/git/repo.test.ts` (it already creates temp repos with `git init`; reuse that helper):

```ts
it('describeWorktree lists commits since base and uncommitted paths', async () => {
  // repo with one base commit; then commit "feat: one" touching a.txt; then write b.txt uncommitted
  const out = await describeWorktree(repo, baseSha);
  expect(out.commits).toHaveLength(1);
  expect(out.commits[0]).toMatch(/^[0-9a-f]{7,} feat: one$/);
  expect(out.dirty).toEqual(['b.txt']);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run packages/core/src/git/repo.test.ts -t describeWorktree`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement `describeWorktree`**

Append to `repo.ts`:

```ts
/**
 * What a worktree has actually done since `base`: committed work and
 * uncommitted paths. This is the part of a checkpoint a session cannot
 * misreport, so CAPO reads it itself rather than asking.
 */
export async function describeWorktree(
  worktree: string,
  base: string,
): Promise<{ commits: string[]; dirty: string[] }> {
  const log = await git(worktree, ['log', '--reverse', '--format=%h %s', `${base}..HEAD`]);
  const commits = log.length === 0 ? [] : log.split('\n');
  const status = await git(worktree, ['status', '--porcelain']);
  const dirty = status.length === 0 ? [] : status.split('\n').map((l) => l.slice(3).trim());
  return { commits, dirty };
}
```

- [ ] **Step 4: Failing orchestrator tests**

Add three tests to `run.test.ts`. Study how existing tests script `FakeAdapter` replies (`replyWithCheckpoint`, `onSend`) and how the acceptance test builds a real git workspace before writing these.

(a) Retry at turn-end:
```ts
it('re-sends the checkpoint request once at turn-end when the first went unanswered', async () => {
  // Fake session for team-a: first send() reply is [{kind:'turn-end'}] only;
  // second send() reply is the fenced checkpoint block for team-a + turn-end.
  await orchestrator.requestSwitch('codex', 'user-switch');
  const set = await latestCheckpointSet(runDir);
  const cp = set!.checkpoints.find((c) => c.sessionId === 'team-a')!;
  expect(cp.objective).not.toMatch(/synthesized/);
  expect(sendsTo('team-a').filter((t) => t === CHECKPOINT_REQUEST)).toHaveLength(2);
});
```

(b) No request on a usage limit:
```ts
it('does not ask sessions on a capped platform for a checkpoint', async () => {
  claude.emit('team-a', { kind: 'usage-limit', raw: 'limit', resetAt: future() });
  await once(orchestrator.events, 'switched');
  expect(sendsTo('team-a')).not.toContain(CHECKPOINT_REQUEST);
  expect(sendsTo('root')).not.toContain(CHECKPOINT_REQUEST);
  const set = await latestCheckpointSet(runDir);
  expect(set!.checkpoints.every((c) => c.objective.includes('synthesized'))).toBe(true);
});
```

(c) Git augmentation (real git workspace like the acceptance test; commit `fix: a` in team-a's worktree before the switch, and leave `notes.txt` uncommitted):
```ts
it('augments a coordinator checkpoint with commits and dirty files from its worktree', async () => {
  await orchestrator.requestSwitch('codex', 'user-switch');
  const cp = (await latestCheckpointSet(runDir))!.checkpoints.find((c) => c.sessionId === 'team-a')!;
  expect(cp.done.some((d) => /^commit [0-9a-f]{7,} fix: a$/.test(d))).toBe(true);
  expect(cp.inProgress.some((d) => d === 'uncommitted in worktree: notes.txt')).toBe(true);
});
```

- [ ] **Step 5: Run to see them fail**

Run: `npx vitest run packages/core/src/orchestrator/run.test.ts -t "checkpoint"`
Expected: the three new tests FAIL.

- [ ] **Step 6: Implement in the orchestrator**

Add field: `readonly #checkpointResent = new Set<SessionId>();`

Change `#checkpointAndCloseAll` so the per-session step is:
```ts
const cp =
  reason === 'usage-limit'
    ? this.#synthesizeCheckpoint(sessionId, live, reason)
    : await this.#requestCheckpoint(sessionId, live, reason);
results.set(sessionId, await this.#stampCheckpoint(sessionId, live, cp));
```

In `#synthesizeCheckpoint`, set `objective` to
`'(synthesized: platform usage limit; the session could not be asked)'` when `reason === 'usage-limit'`, else keep the current text.

In `#requestCheckpoint`'s `finish`, also `this.#checkpointResent.delete(sessionId)`.

In `#onEvent` `case 'turn-end'`:
```ts
case 'turn-end': {
  const resolver = this.#pending.get(sessionId);
  const live = this.#live.get(sessionId);
  if (resolver && live && !this.#checkpointResent.has(sessionId)) {
    // The first request was injected into a running turn and the model
    // answered its own turn instead. Ask once more now that it is listening.
    this.#checkpointResent.add(sessionId);
    this.#log(`[${sessionId}] no checkpoint in its last turn; asking once more`);
    live.session.send(CHECKPOINT_REQUEST).catch(() => {});
  }
  break;
}
```

Make `#stampCheckpoint` async and augment:
```ts
async #stampCheckpoint(sessionId: SessionId, live: LiveSession, cp: Checkpoint): Promise<Checkpoint> {
  const state = this.#state.get();
  const stamped: Checkpoint = { ...cp, sessionId, runId: state.runId, role: live.role,
    platform: live.platform, written: new Date().toISOString(), baseCommit: state.baseCommit };
  if (live.role !== 'coordinator') return stamped;
  try {
    const { commits, dirty } = await describeWorktree(this.#cwdFor('coordinator', sessionId), state.baseCommit);
    for (const c of commits) {
      const sha = c.split(' ')[0] ?? '';
      if (!stamped.done.some((d) => d.includes(sha))) stamped.done.push(`commit ${c}`);
    }
    if (dirty.length > 0) {
      const line = `uncommitted in worktree: ${dirty.join(', ')}`;
      if (!stamped.inProgress.includes(line)) stamped.inProgress.unshift(line);
    }
  } catch (err) {
    this.#log(`[${sessionId}] could not read worktree for checkpoint: ${err instanceof Error ? err.message : String(err)}`);
  }
  return stamped;
}
```
Import `describeWorktree` from `../git/repo.js`.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A packages/core/src
git commit -m "fix(checkpoint): retry once, skip capped sessions, and add git facts"
```

---

### Task 4: Nudge a coordinator whose turn ends without a result

Finding 7: a coordinator gets one turn; if it ends without a `# Result:` block nothing ever prompts it again, and the stall mark is informational. Both live runs only finished because Haiku emitted the block first time.

**Files:**
- Modify: `packages/core/src/orchestrator/prompt.ts` (add `RESULT_NUDGE`, `MAX_RESULT_NUDGES`)
- Modify: `packages/core/src/orchestrator/run.ts` (`#onEvent` `turn-end`, `#launchOne`)
- Modify: `packages/core/src/orchestrator/run.test.ts`

**Interfaces:**
- Produces: `export const MAX_RESULT_NUDGES = 3;` and `export function renderResultNudge(taskIds: TaskId[]): string` in `prompt.ts`.

- [ ] **Step 1: Failing tests**

```ts
it('nudges a coordinator whose turn ended with its task still running, at most MAX_RESULT_NUDGES times', async () => {
  for (let i = 0; i < 5; i++) { claude.emit('team-a', { kind: 'turn-end' }); await tick(); }
  const nudges = sendsTo('team-a').filter((t) => t.startsWith('CAPO: your turn ended'));
  expect(nudges).toHaveLength(MAX_RESULT_NUDGES);
  expect(nudges[0]).toContain('component-a');
});

it('does not nudge once the task is in review, or the root, or during a switch', async () => {
  // emit a valid result block for team-a, then turn-end: no nudge
  // emit turn-end on root: no nudge
});
```
`tick()` is `await new Promise((r) => setImmediate(r))` repeated a few times; the file may already have such a helper.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run packages/core/src/orchestrator/run.test.ts -t nudge`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `prompt.ts`:
```ts
export const MAX_RESULT_NUDGES = 3;

/** Sent when a coordinator's turn ends with an owned task still open. */
export function renderResultNudge(taskIds: TaskId[]): string {
  return [
    `CAPO: your turn ended but task(s) ${taskIds.join(', ')} are still open -- no \`# Result:\` block has been received.`,
    'If the work is committed in your worktree, reply now with the fenced result block described under "Result protocol".',
    'If you are blocked, state the blocker in one paragraph and stop. Do not start unrelated work.',
  ].join('\n');
}
```
(import `TaskId` from `../types.js`.)

In `run.ts`: add `readonly #nudges = new Map<SessionId, number>();`. In `#launchOne`, after `#live.set`: `this.#nudges.set(sessionId, 0);`. In the `turn-end` case, after the checkpoint-retry block from Task 3:
```ts
if (live && live.role === 'coordinator' && !resolver && !this.#switching && !this.#integrating) {
  const open = Object.values(this.#state.get().tasks)
    .filter((t) => t.coordinator === sessionId && t.state === 'running')
    .map((t) => t.id);
  const count = this.#nudges.get(sessionId) ?? 0;
  if (open.length > 0 && count < MAX_RESULT_NUDGES) {
    this.#nudges.set(sessionId, count + 1);
    this.#log(`[${sessionId}] turn ended with ${open.join(', ')} still open; nudge ${count + 1}/${MAX_RESULT_NUDGES}`);
    live.session.send(renderResultNudge(open)).catch(() => {});
  } else if (open.length > 0 && count === MAX_RESULT_NUDGES) {
    this.#nudges.set(sessionId, count + 1);
    this.#log(`[${sessionId}] no result after ${MAX_RESULT_NUDGES} nudges; leaving it to the stall watchdog`);
  }
}
```
Also delete the session's entry from `#nudges` wherever `#lastEventAt.delete(sessionId)` is called.

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A packages/core/src
git commit -m "feat(orchestrator): nudge a coordinator whose turn ends without a result"
```

---

### Task 5: Reject a result whose commit is not a git sha

Finding 8: `parseResult` accepts any `# Result:` fence, so a coordinator quoting the protocol template moves its task to review with commit `<the commit sha in your task worktree>`, integration fires, and the run fails.

**Files:**
- Modify: `packages/core/src/orchestrator/run.ts` (`#handleResult`)
- Modify: `packages/core/src/orchestrator/run.test.ts`

- [ ] **Step 1: Failing test**

```ts
it('ignores a result block whose commit is not a git sha', async () => {
  claude.emit('team-a', { kind: 'text', text: '```markdown\n# Result: component-a\ntask: component-a\ncommit: <the commit sha in your task worktree>\n\n## Evidence\nnone\n```' });
  await tick();
  expect(store.get().tasks['component-a']!.state).toBe('running');
  expect(store.get().tasks['component-a']!.resultCommit).toBeUndefined();
});
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run packages/core/src/orchestrator/run.test.ts -t "not a git sha"`. Expected: FAIL (state is `review`).

- [ ] **Step 3: Implement**

In `#handleResult`, after `parseResult` succeeds and before resolving the task:
```ts
if (!/^[0-9a-f]{7,40}$/i.test(raw.resultCommit)) {
  this.#log(`[${sessionId}] result ignored: commit "${raw.resultCommit}" is not a git sha`);
  return;
}
```

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A packages/core/src
git commit -m "fix(result): ignore a result block whose commit is not a sha"
```

---

### Task 6: Events from a closed session no longer drive the state machine

Finding 5: `#pump` keeps dispatching buffered events after `close()`, and `#onEvent` never checks liveness. A `usage-limit` buffered on the old platform's session and delivered after the switch completes would call `requestSwitch` again, close the healthy new platform, and park the run in `waiting`.

**Files:**
- Modify: `packages/core/src/orchestrator/run.ts` (`#pump`, `#onEvent` `usage-limit` case)
- Modify: `packages/core/src/orchestrator/run.test.ts`

- [ ] **Step 1: Failing test**

Build a subclass of `FakeAdapter` in the test file whose `start()` wraps the returned session so that `events()` yields the underlying events and then, 200 ms after the underlying stream ends, one extra `{ kind: 'usage-limit', raw: 'stale', resetAt: future() }` before reporting done:

```ts
class LateLimitFakeAdapter extends FakeAdapter {
  override async start(opts: StartSessionOptions): Promise<AdapterSession> {
    const inner = await super.start(opts);
    const late = { kind: 'usage-limit', raw: 'stale', resetAt: future() } as const;
    return {
      ...inner,
      get platformSessionId() { return inner.platformSessionId; },
      events(): AsyncIterable<AdapterEvent> {
        const src = inner.events()[Symbol.asyncIterator]();
        let sentLate = false;
        return { [Symbol.asyncIterator]() { return { async next() {
          const r = await src.next();
          if (!r.done || sentLate) return r;
          sentLate = true;
          await new Promise((res) => setTimeout(res, 200));
          return { value: late, done: false };
        } }; } };
      },
    };
  }
}

it('ignores a usage-limit that a closed session delivers after the switch has completed', async () => {
  // claude = new LateLimitFakeAdapter('claude'), codex = ordinary armed fake
  claude.emit('team-a', { kind: 'usage-limit', raw: 'real', resetAt: future() });
  await once(orchestrator.events, 'switched');
  await new Promise((r) => setTimeout(r, 500));
  const s = store.get();
  expect(s.activePlatform).toBe('codex');
  expect(s.status).toBe('running');
  expect(s.pauseCount).toBe(1);
});
```
(Use the file's existing arming helper so checkpoint requests are answered; Task 3 means a `usage-limit` pause sends none anyway.)

- [ ] **Step 2: Run to see it fail** — Expected: FAIL (`status` is `waiting`, `pauseCount` 2).

- [ ] **Step 3: Implement**

In `#pump`'s loop:
```ts
for await (const event of session.events()) {
  if (this.#live.get(sessionId)?.session !== session) {
    // A closed session draining its buffer. Keep it in the transcript for
    // the record, but nothing it says can move the run any more.
    if (this.#config.transcripts) {
      const line = renderEvent(event);
      if (line !== undefined) void appendTranscript(this.#runDir, sessionId, line);
    }
    continue;
  }
  await this.#onEvent(sessionId, platform, event);
}
```
And in the `usage-limit` case, guard on platform too:
```ts
case 'usage-limit': {
  if (platform !== this.#state.get().activePlatform) {
    this.#log(`[${sessionId}] usage-limit from ${platform}, which is no longer active; ignored`);
    break;
  }
  ...existing body...
}
```

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A packages/core/src
git commit -m "fix(orchestrator): ignore events from a session that has been closed"
```

---

### Task 7: `switch` and `resume` find the workspace, and `switch` refuses a finished run

Finding 6: `switch`/`resume` use `process.cwd()` and have no `--workspace`; from the repo root against the example config they fail. `switch` on a finished run says "resume it instead".

**Files:**
- Modify: `packages/cli/src/lib/run-locate.ts` (add `locateWorkspace`)
- Modify: `packages/cli/src/commands/status.ts`, `switch.ts`, `resume.ts`
- Modify: `packages/cli/src/main.ts` (`HELP_TEXT`, `dispatchSwitch`, `dispatchResume`)
- Modify: `packages/cli/src/main.test.ts`
- Modify: `plugins/claude/capo/skills/capo/SKILL.md`, `plugins/codex/capo/skills/capo/SKILL.md` (command signatures)

**Interfaces:**
- Produces: `export async function locateWorkspace(start: string, runId?: string): Promise<string>` in `run-locate.ts`.
- `SwitchOpts` and `ResumeOpts` gain `workspace?: string`.

- [ ] **Step 1: Failing tests in `main.test.ts`**

Study how the file builds a temp workspace with `.capo/runs/<id>/state.json` and calls `main()` with a captured `Io`. Add:

```ts
it('switch --workspace finds the run and refuses one that is already done', async () => {
  // state.json with status: 'done'
  const code = await main(['switch', runId, '--workspace', ws], io);
  expect(code).toBe(1);
  expect(io.errText()).toContain(`run ${runId} is already done; nothing to switch`);
});

it('locateWorkspace walks up from a subdirectory to the directory holding .capo/runs/<id>', async () => {
  const sub = join(ws, 'src', 'deep'); await mkdir(sub, { recursive: true });
  expect(await locateWorkspace(sub, runId)).toBe(ws);
  await expect(locateWorkspace(tmpdir(), 'nope')).rejects.toThrow(/no run/);
});
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run packages/cli/src/main.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `locateWorkspace`**

```ts
/**
 * Walks up from `start` to the first directory that holds `.capo/runs/<runId>`
 * (or any `.capo/runs` when no id is given). `capo run` resolves the
 * workspace from the config file, so the shell that later types `capo switch`
 * is often somewhere else -- a monorepo root, an editor's cwd, a plugin's
 * conversation. Making the person guess the right directory is a bug.
 */
export async function locateWorkspace(start: string, runId?: string): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    const probe = runId ? join(capoDir(dir), 'runs', runId) : join(capoDir(dir), 'runs');
    try { await stat(probe); return dir; } catch { /* keep climbing */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CapoError(
    runId ? `no run ${runId} found at or above ${resolve(start)}` : `no run found at or above ${resolve(start)}`,
    'pass --workspace <dir>, or run this from inside the project the run was started in',
  );
}
```

- [ ] **Step 4: Use it in the three commands**

`status.ts`: `const workspace = opts.workspace !== undefined ? resolve(opts.workspace) : await locateWorkspace(process.cwd(), opts.runId);` (inside the try). Keep `latestRunId` for the no-id case.

`switch.ts` and `resume.ts`: add `workspace?: string` to opts; same resolution with `opts.runId`. In `switch.ts`, after `readState` succeeds:
```ts
if (state.status === 'done' || state.status === 'failed') {
  io.err(`run ${opts.runId} is already ${state.status}; nothing to switch`);
  return 1;
}
```

`main.ts`: add `workspace: { type: 'string' }` to `dispatchSwitch` and `dispatchResume` options, pass it through; update `HELP_TEXT` lines to `capo switch <run-id> [--to <platform>] [--workspace <dir>]` and `capo resume <run-id> [--workspace <dir>]`.

- [ ] **Step 5: Update both SKILL.md files**

Change the `switch` and `resume` signatures to include `[--workspace <dir>]` and add one sentence under each: "Pass `--workspace` with the project directory the run was started in when this conversation's working directory is somewhere else; without it CAPO looks for `.capo/runs/<run-id>` in the current directory and its parents."

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A packages/cli/src plugins/claude/capo/skills plugins/codex/capo/skills
git commit -m "feat(cli): locate the workspace for switch and resume, refuse switching a finished run"
```

---

### Task 8: `setup_command`, and reject empty `tasks`

Finding 9: fresh worktrees have no dependencies, so on any real project `check_command` and coordinator test runs fail. Finding 10: the advertised "leave tasks empty and the root decomposes" mode cannot work (nothing creates tasks; zero tasks never integrate).

**Files:**
- Modify: `packages/core/src/config/schema.ts`, `load.ts`, `load.test.ts`
- Modify: `packages/core/src/types.ts` (`CapoConfig.setupCommand`)
- Modify: `packages/core/src/orchestrator/run.ts` (`start()`)
- Modify: `packages/core/src/integrate/merge.ts` (`integrate()` option), `merge.test.ts`
- Modify: `packages/core/src/orchestrator/run.test.ts`
- Modify: `README.md` (config block + remove the empty-tasks sentence), `examples/two-coordinators/orchestration.yaml`

**Interfaces:**
- `CapoConfig.setupCommand: string[]`.
- `integrate(opts)` gains `setupCommand?: string[]`, run with `cwd: worktree` after the merge loop and before `checkCommand`; a non-zero exit sets `checksPassed = false` and `checkOutput = 'setup_command failed:\n' + output` and skips `checkCommand`.

- [ ] **Step 1: Failing config tests**

In `load.test.ts`: change the existing `tasks: []` test to
```ts
await expect(loadConfig(p)).rejects.toThrow(/at least one task/);
```
and add
```ts
it('parses setup_command as argv and defaults it to []', async () => {
  const cfg = await loadConfig(await scaffold(VALID + 'setup_command: ["npm", "ci"]\n'));
  expect(cfg.setupCommand).toEqual(['npm', 'ci']);
  const cfg2 = await loadConfig(await scaffold(VALID));
  expect(cfg2.setupCommand).toEqual([]);
});
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run packages/core/src/config/load.test.ts`. Expected: FAIL.

- [ ] **Step 3: Schema, loader, types**

`schema.ts`, after `check_command`:
```ts
// Run once in every coordinator worktree right after it is created, and
// once in the integration worktree after all merges and before
// check_command -- e.g. ["npm", "ci"]. A fresh git worktree has no
// node_modules, no build output, nothing a real project needs to run its
// tests. argv, not a shell string.
setup_command: z.array(z.string()).default([]),
```
`load.ts`: `setupCommand: file.setup_command,` in the `cfg` literal; and in `validateTasks`, first line:
```ts
if (file.tasks.length === 0) {
  throw new CapoError(
    'v0.1 requires at least one task under tasks:',
    'Declare each unit of work with an id, a coordinator, a brief, and a write_scope. Root-driven decomposition is not implemented.',
  );
}
```
`types.ts`: add `setupCommand: string[];` to `CapoConfig` with a one-line doc.

- [ ] **Step 4: Failing orchestrator and integrate tests**

`run.test.ts` (real git workspace, like the acceptance test): config with `setup_command: ["node", "-e", "require('fs').writeFileSync('setup.marker', process.cwd())"]`; after `start()`, assert `setup.marker` exists in both coordinator worktrees. A second test: `setup_command: ["node", "-e", "process.exit(3)"]` makes `start()` reject with `/setup_command failed/`.

`merge.test.ts`: reuse an existing integrate test; pass `setupCommand: ['node', '-e', "require('fs').writeFileSync('setup.marker','1')"]` and assert the marker exists in the integration worktree; another with `['node','-e','process.exit(2)']` expects `checksPassed === false` and `checkOutput` to start with `setup_command failed`.

- [ ] **Step 5: Implement**

`run.ts` `start()`: after `addWorktree(...)` inside the coordinator loop:
```ts
await this.#runSetup(worktree);
```
and add:
```ts
async #runSetup(cwd: string): Promise<void> {
  const [cmd, ...args] = this.#config.setupCommand;
  if (cmd === undefined) return;
  try {
    await execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CapoError(`setup_command failed in ${cwd}: ${detail}`, 'fix setup_command in the config, or run it by hand in that worktree and resume');
  }
}
```
(`import { execFile as execFileCb } from 'node:child_process'; import { promisify } from 'node:util'; const execFile = promisify(execFileCb);` at the top, matching `merge.ts`.) Pass `setupCommand: this.#config.setupCommand.length > 0 ? this.#config.setupCommand : undefined` into `integrate(...)` in `#runIntegration`.

`merge.ts` `integrate()`: after the merge loop, before the check block:
```ts
if (setupCommand && setupCommand.length > 0) {
  const [cmd, ...args] = setupCommand as [string, ...string[]];
  try {
    await execFile(cmd, args, { cwd: worktree, maxBuffer: MAX_BUFFER });
  } catch (err) {
    return { merged, conflicted, checksPassed: false, checkOutput: `setup_command failed:\n${execErrorOutput(err)}` };
  }
}
```

- [ ] **Step 6: README and example**

README config block: add `setup_command: ["npm", "ci"]   # optional; runs in every fresh worktree` after `check_command`, and in "Ownership and integration" one sentence: "If `setup_command` is set it runs in each coordinator worktree at creation and in the integration worktree before the check, because a fresh worktree has no installed dependencies." Delete the sentence `tasks:             # optional: leave empty and the root decomposes the objective` (make it `tasks:             # at least one; each names its coordinator and write scope`). Example YAML: add a commented `# setup_command: ["npm", "ci"]` with the same explanation.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A packages/core/src README.md examples/two-coordinators/orchestration.yaml
git commit -m "feat(config): add setup_command for fresh worktrees and require at least one task"
```

---

### Task 9: Limit text on a Claude result line, clean state writes at exit, warning rendering

Finding 4 (partial) and finding 10 items. (a) The Claude adapter never applies `USAGE_LIMIT_RE` to an `is_error` result line, though the CLI's own error phrase list includes "usage limit reached" and historically the `-p` result text is `Claude AI usage limit reached|<unix-seconds>`. (b) Every run leaves `state.json.<pid>.<n>.tmp` because teardown exits mid-write. (c) Codex hook warnings render as `**error**` in transcripts.

**Files:**
- Modify: `packages/core/src/adapters/claude.ts` (`mapLine` result branch; add `epochSuffixToIso`), `claude.test.ts`
- Modify: `packages/core/src/state/store.ts` (add `flush()`), `store.test.ts`
- Modify: `packages/core/src/orchestrator/run.ts` (add `flush()`)
- Modify: `packages/cli/src/lib/signals.ts` (`teardown`)
- Modify: `packages/core/src/orchestrator/transcript.ts`, `transcript.test.ts`

- [ ] **Step 1: Failing tests**

`claude.test.ts` (use the stub the file already drives with scripted lines):
```ts
it('maps an is_error result carrying the usage-limit phrase to usage-limit with the epoch reset time', async () => {
  // stub emits: {"type":"result","is_error":true,"result":"Claude AI usage limit reached|1757800000"}
  expect(events).toContainEqual({ kind: 'usage-limit', raw: 'Claude AI usage limit reached|1757800000', resetAt: '2025-09-13T21:46:40.000Z' });
  expect(events.some((e) => e.kind === 'error')).toBe(false);
  expect(events.at(-1)).toEqual({ kind: 'turn-end' });
});
```
`store.test.ts`:
```ts
it('flush() resolves after every queued update has been written and leaves no tmp files', async () => {
  void store.update((d) => { d.pauseCount = 1; });
  void store.update((d) => { d.pauseCount = 2; });
  await store.flush();
  expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).pauseCount).toBe(2);
});
```
`transcript.test.ts`:
```ts
it('renders a retryable error as a warning, not an error', () => {
  expect(renderEvent({ kind: 'error', message: 'clamping hook timeout', retryable: true })).toBe('\n> _warning_: clamping hook timeout\n');
});
```

- [ ] **Step 2: Run to see them fail** — the three files. Expected: FAIL.

- [ ] **Step 3: Implement**

`claude.ts`:
```ts
/** "…usage limit reached|1757800000": the CLI's historical -p result text carries the reset as unix seconds after a pipe. */
function epochSuffixToIso(text: string): string | undefined {
  const m = /\|(\d{9,11})\b/.exec(text);
  return m ? resetsAtToIso(Number(m[1])) : undefined;
}
```
In the `result` branch:
```ts
if (obj.type === 'result') {
  const events: AdapterEvent[] = [];
  const text = typeof obj.result === 'string' ? obj.result : '';
  if (obj.is_error === true && USAGE_LIMIT_RE.test(text)) {
    const resetAt = epochSuffixToIso(text) ?? extractResetAt(text);
    events.push(resetAt !== undefined ? { kind: 'usage-limit', raw: text, resetAt } : { kind: 'usage-limit', raw: text });
  } else if (obj.is_error === true) {
    events.push({ kind: 'error', message: text.length > 0 ? text : 'claude-code: turn ended with an error', retryable: false });
  }
  events.push({ kind: 'turn-end' });
  return events;
}
```

`store.ts`: `async flush(): Promise<void> { await this.#queue; }`.
`run.ts`: `async flush(): Promise<void> { await this.#state.flush(); }` (public, next to `stop()`).
`signals.ts` `teardown`: replace `void clearPidFile(dir).finally(resolve);` with
```ts
void orchestrator.flush().catch(() => {}).then(() => clearPidFile(dir)).finally(resolve);
```
`transcript.ts` `renderEvent` `error` case:
```ts
case 'error':
  return event.retryable
    ? `\n> _warning_: ${event.message}\n`
    : `\n> **error**: ${event.message}\n`;
```
Update any existing transcript test that asserted the old `(retryable)` wording.

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A packages/core/src packages/cli/src
git commit -m "fix: detect a limit on a Claude result line, flush state at exit, render warnings as warnings"
```

---

### Task 10: Docs, plugin bundles, and the honest README

Bring the written record in line with the code, then rebuild the committed plugin bundles so the installed skill drives the new CLI.

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/notes/first-complete-run.md` (append a section)
- Rebuild: `plugins/claude/capo/dist/capo.mjs`, `plugins/codex/capo/dist/capo.mjs` via `npm run build:plugins`

- [ ] **Step 1: README edits**

1. In "What sessions are allowed to do", replace the sentence beginning "What bounds it is where sessions run." through the end of that paragraph with:
```markdown
Be clear about what that grant is and is not. A git worktree bounds where
*git-tracked changes* land; it does not bound what a process can do. A
Claude Code session in this mode can run any command on your machine, and
the Codex sandbox is the only OS-level boundary either platform offers.
What CAPO adds on top: the root is launched read-only on both platforms,
every coordinator runs in its own worktree, and nothing merges into your
tree until CAPO has re-checked the diff against the declared write scope.
```
2. In "How it works", after item 3, add: `Checkpoints are augmented with what CAPO can read itself: commits and uncommitted paths in each coordinator's worktree. On a usage limit no session is asked; each gets that mechanical checkpoint. On a hand-forced switch the session is asked, and asked once more if its current turn ends without answering.`
3. In "Quickstart" command list, show `capo switch <run-id> [--workspace <dir>]` and `capo resume <run-id> [--workspace <dir>]` with the comment `# from anywhere inside the project, or pass --workspace`.
4. In "What is not done", add bullets: `Codex sessions still load every plugin in ~/.codex/config.toml; there is no per-session isolation flag.` and `A coordinator that ignores three result nudges is only marked stalled.`
5. Remove the sentence "Also not done: ... Moving a single task ..." — keep it; only remove claims that are now false: the `tasks:` "optional" comment (done in Task 8) and the phrase "the root ... integrates" if any remain.

- [ ] **Step 2: architecture.md**

In "What exists today", update the bullets that describe the root, checkpoints, and `autonomy` to match Tasks 1-4 (root read-only; checkpoint retry/skip/augment; nudges; sha validation; stale-event guard). Replace the sentence "The root stays in the workspace: it integrates, so it needs to see everything." if present with "The root stays in the workspace, read-only."

- [ ] **Step 3: Append to first-complete-run.md**

```markdown
## A switch under review, and what it changed

Recorded 2026-09-13. Two more live runs of the fixture on Haiku, the second
forced to Codex at 20 seconds. Both integrated 2/2. The second found: the
relaunched root spawned two Codex subagents that committed both fixes to
the workspace's `main`; one of three checkpoints was synthesized empty
because the request landed mid-turn and the model answered with its result
instead; the root loaded this machine's CAPO plugin skill and drove `capo
status` against its own run. The root is now launched read-only, Claude
sessions drop user-scope settings, checkpoints are re-asked once and
augmented from git, and a limit-triggered pause asks nobody.
```

- [ ] **Step 4: Rebuild bundles and run everything**

```bash
npm run build && npm run build:plugins && npm test && npm run typecheck
git status --short   # both plugins/*/capo/dist/capo.mjs should be modified
```

- [ ] **Step 5: Commit**

```bash
git add -A README.md docs plugins
git commit -m "docs: record the review fixes and rebuild the plugin bundles"
```
