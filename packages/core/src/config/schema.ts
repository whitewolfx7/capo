import { z } from 'zod';

/**
 * Zod schema over the snake_case wire shape of the config file, as read
 * from YAML or JSON. This schema does not know about `CapoConfig`
 * (camelCase, absolute paths, frozen). `load.ts` converts between the two.
 */
export const configFileSchema = z
  .object({
    version: z.literal(1),
    workspace: z.string().default('.'),
    objective: z.string(),
    platforms: z.record(z.string(), z.object({ driver: z.string().min(1) }).strict()),
    start_on: z.string(),
    models: z
      .object({
        root: z.record(z.string(), z.string()),
        coordinator: z.record(z.string(), z.string()),
        worker: z.record(z.string(), z.string()),
      })
      .strict(),
    roles: z
      .object({
        root: z.string(),
        coordinator: z.string(),
        worker: z.string(),
      })
      .strict(),
    context: z.array(z.string()).default([]),
    coordinators: z
      .array(z.object({ id: z.string().min(1) }).strict())
      .min(1),
    tasks: z
      .array(
        z
          .object({
            id: z.string().min(1),
            coordinator: z.string(),
            brief: z.string(),
            write_scope: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .default([]),
    transcripts: z.boolean().default(true),
    // 5 minutes. Long enough that a session mid a slow build or test run
    // isn't flagged on every routine lull, short enough that a person
    // watching a run notices well before "is it stuck?" becomes "did I lose
    // an hour to this?".
    stall_timeout_ms: z.number().int().positive().default(300_000),
    // Defaults to 'autonomous' because CAPO runs sessions HEADLESS: there is
    // nobody present to answer an approval request, so a supervised run simply
    // stalls. That is the exact bug this setting was added to fix, and a
    // default that reproduces it fixes nothing.
    //
    // This is not a permissiveness increase for Claude Code, which CAPO has
    // always launched with --permission-mode acceptEdits. It brings Codex up to
    // the same footing via --approve-for-me, which keeps the workspace-write
    // sandbox, rather than --dangerously-bypass-approvals-and-sandbox.
    //
    // What makes that defensible: a coordinator owning one task runs in that
    // task's own git worktree, not the user's working tree, and every task
    // declares a write scope that integrate/merge.ts re-checks against each
    // submitted diff, renames included.
    //
    // Read that precisely. A coordinator owning SEVERAL tasks still runs in
    // the shared workspace, because a per-task worktree cannot be picked for
    // it, and integration is not yet wired into a run at all. So today the
    // real guard is the write scope and your own review of the diff, not
    // filesystem isolation. Give each coordinator exactly one task if you want
    // the isolation this argument assumes.
    //
    // Set `autonomy: supervised` for a dry run: sessions read and plan but do
    // not write.
    autonomy: z.enum(['supervised', 'autonomous']).default('autonomous'),
    // The combined check integration runs once, over the fully integrated
    // tree, after every task's result has merged -- e.g. ["npm", "test"].
    // argv, not a shell string. No sensible non-empty default exists: CAPO
    // cannot guess how a project verifies itself. An empty array (the
    // default) means integration accepts a clean merge on its own.
    check_command: z.array(z.string()).default([]),
    limits: z
      .object({
        max_workers_per_coordinator: z.number().int().positive().default(2),
      })
      .strict()
      // Zod 4 no longer re-parses a top-level default through the inner
      // schema (https://zod.dev/v4/changelog -- defaults are applied once,
      // statically), so the fallback must already be the fully-defaulted
      // shape rather than `{}`.
      .default({ max_workers_per_coordinator: 2 }),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
