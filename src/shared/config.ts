import { z } from "zod";
import { RuntimeLimitsSchema, type RuntimeLimits } from "./contracts.js";

export const DEFAULT_LIMITS = RuntimeLimitsSchema.parse({
  maxVersions: 3,
  maxModelCalls: 7,
  modelTimeoutMs: 180_000,
  modelWarningMs: 30_000,
  maxTaskChars: 8_000,
  maxArtifactBytes: 64 * 1024,
  maxContextBytes: 96 * 1024,
  checkTimeoutMs: 5_000,
  checkMemoryBytes: 64 * 1024 * 1024,
}) satisfies RuntimeLimits;

export const ModelAssignmentsSchema = z.object({
  author: z.string().min(1),
  reviewer: z.string().min(1),
  applier: z.string().min(1),
}).refine((models) => models.author !== models.reviewer, "author and reviewer must use different models");
export type ModelAssignments = z.infer<typeof ModelAssignmentsSchema>;

export const DEFAULT_MODELS: ModelAssignments = ModelAssignmentsSchema.parse({
  author: "gpt-6-sol",
  reviewer: "gpt-6-luna",
  applier: "gpt-6-sol",
});

export const AppConfigSchema = z.object({
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  dataDir: z.string().min(1),
  executionMode: z.enum(["real", "fake"]),
  fakeScenario: z.enum(["happy", "review_loop", "no_response", "review_once", "slow"]),
  models: ModelAssignmentsSchema,
  limits: RuntimeLimitsSchema,
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return AppConfigSchema.parse({
    host: "127.0.0.1",
    port: Number(env.APP_PORT ?? 4317),
    dataDir: env.APP_DATA_DIR ?? ".local-data",
    executionMode: env.APP_CODEX_MODE ?? "real",
    fakeScenario: env.APP_FAKE_SCENARIO ?? "happy",
    models: {
      author: env.AUTHOR_MODEL ?? DEFAULT_MODELS.author,
      reviewer: env.REVIEWER_MODEL ?? DEFAULT_MODELS.reviewer,
      applier: env.APPLIER_MODEL ?? DEFAULT_MODELS.applier,
    },
    limits: DEFAULT_LIMITS,
  });
}
