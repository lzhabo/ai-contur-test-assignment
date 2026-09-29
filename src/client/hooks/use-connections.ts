import { useQuery } from "@tanstack/react-query";
import { getConnections } from "../api/connections";

/** Обновляет проверку при открытии, возврате к окну и по команде пользователя. */
export function useConnections() {
  const query = useQuery({
    queryKey: ["connections"],
    queryFn: ({ signal }) => getConnections(signal),
    retry: false,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  return {
    data: query.data,
    ready: query.data?.ready === true && !query.isError && !query.isFetching,
    checking: query.isFetching,
    error: query.isError
      ? "Не удалось связаться с сервером приложения и проверить Codex. Убедитесь, что сервер запущен, затем нажмите «Проверить снова»."
      : "",
    recheck: () => {
      void query.refetch();
    },
  };
}
