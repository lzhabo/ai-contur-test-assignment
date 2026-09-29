import { z } from "zod";

export const MockScenarioSchema = z.enum([
  "happy",
  "review_loop",
  "no_response",
  "review_once",
  "slow",
]);
export type MockScenario = z.infer<typeof MockScenarioSchema>;
