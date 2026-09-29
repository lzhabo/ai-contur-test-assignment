import { CodexReadinessSchema, type CodexReadiness } from "../../shared/connections";
import { requestJson } from "./http";

/** Запрашивает свежую локальную проверку CLI и входа без облачной генерации. */
export function getConnections(signal?: AbortSignal): Promise<CodexReadiness> {
  return requestJson("/api/connections", CodexReadinessSchema, { signal, cache: "no-store" });
}
