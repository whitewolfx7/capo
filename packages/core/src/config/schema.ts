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
    platforms: z.record(z.object({ driver: z.string().min(1) }).strict()),
    start_on: z.string(),
    models: z
      .object({
        root: z.record(z.string()),
        coordinator: z.record(z.string()),
        worker: z.record(z.string()),
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
    limits: z
      .object({
        max_workers_per_coordinator: z.number().int().positive().default(2),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
