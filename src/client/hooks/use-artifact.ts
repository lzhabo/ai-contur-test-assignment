import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ArtifactFileSummary } from "../../shared/api";
import { getArtifact } from "../api/tasks";
import { taskKeys } from "./task-cache";

/** Загружает выбранный файл; отдельный ключ и отмена защищают от устаревшего содержимого. */
export function useArtifact(
  taskId: string,
  file: ArtifactFileSummary | undefined,
): UseQueryResult<string, Error> {
  return useQuery({
    queryKey: file ? taskKeys.artifact(taskId, file) : ["artifact", taskId, null],
    // Получает текст только выбранной версии; смена ключа отменяет прежний запрос.
    queryFn: ({ signal }) => {
      if (!file) throw new Error("Файл ещё не выбран.");
      return getArtifact(taskId, file, signal);
    },
    enabled: Boolean(file),
    retry: false,
    staleTime: Infinity,
  });
}
