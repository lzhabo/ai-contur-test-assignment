import type { TaskPhase } from "../../shared/api";

export const PHASES: Record<TaskPhase, string> = {
  preparing: "Подготовка",
  author: "Автор пишет функцию",
  checking: "Проверка функции",
  review: "Ревью кода",
  awaiting_approval: "Нужно ваше решение",
  applying: "Сохранение результата",
  completed: "Готово",
  stopped: "Остановлено",
  error: "Ошибка",
  unknown_outcome: "Исход вызова неизвестен",
};
export const ROLES: Record<string, string> = {
  author: "Автор",
  reviewer: "Ревьюер",
  applier: "Применяющий агент",
  system: "Приложение",
  user: "Вы",
};
export const EXAMPLE_DESCRIPTIONS = [
  "Пересечения, касания и вложенные интервалы. Проверим граничные случаи.",
  "Путь между двумя вершинами графа. Поиск в ширину и проверка циклов.",
  "Каждое слово превращается в «мяу». Пробелы, цифры и пунктуация остаются.",
];
/** Форматирует время наблюдения агента для локального интерфейса. */
export const time = (date: string): string =>
  new Date(date).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
