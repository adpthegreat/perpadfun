import { z } from "zod";

// One durable per-token log row, as the keeper POSTs it to /workflow-report.
// Single source of truth for inbound validation; mirrors the keeper_logs table
// and keeper/src/workflow.js buildLogRow(). See KEEPER_PER_TOKEN_LOGS.md.
export const KeeperLogSchema = z.object({
  token_id: z.string().uuid(),
  tick_id: z.string().max(64).nullable().optional(),
  level: z.enum(["info", "warn", "error"]).default("info"),
  event: z.string().max(64).nullable().optional(),
  message: z.string().min(1).max(2000),
  fields: z.record(z.string(), z.unknown()).default({}),
});

export type KeeperLog = z.infer<typeof KeeperLogSchema>;
