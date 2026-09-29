import { z } from "zod";

export const ConnectionCheckSchema = z.object({
  id: z.enum(["cli", "auth", "cloud"]),
  status: z.enum(["passed", "failed", "not_checked"]),
  message: z.string(),
});
export const CodexReadinessSchema = z.object({
  executionMode: z.enum(["real", "mock"]),
  ready: z.boolean(),
  checkedAt: z.iso.datetime(),
  checks: z.array(ConnectionCheckSchema),
});
export type CodexReadiness = z.infer<typeof CodexReadinessSchema>;
