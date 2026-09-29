import { type ReactElement } from "react";
import { MAX_TASK_CHARS } from "../../shared/limits";
import { TASK_EXAMPLES } from "../../shared/examples";
import { ADVANCED_EXAMPLE } from "../../shared/advanced-example";
import { EXAMPLE_DESCRIPTIONS } from "./labels";

interface NewTaskProps {
  text: string;
  setText: (text: string) => void;
  serverMode: "real" | "mock" | undefined;
  activeId: string | null;
  busy: boolean;
  connectionReady: boolean;
  create: (text: string) => Promise<void>;
  selectTask: (id: string | null) => void;
}

/** Отображает форму и примеры; текст остаётся локальным до команды создания. */
export function NewTask({
  text,
  setText,
  serverMode,
  activeId,
  busy,
  connectionReady,
  create,
  selectTask,
}: NewTaskProps): ReactElement {
  /** Подставляет пример и оставляет решение о запуске пользователю. */
  function chooseExample(value: string): void {
    setText(value);
    document.getElementById("task-text")?.focus();
  }
  return (
    <>
      <div className="intro">
        <div className="eyebrow">От идеи к проверенной функции</div>
        <h1>
          Опишите задачу.
          <br />
          Агенты займутся кодом.
        </h1>
        <p>
          Автор напишет функцию, ревьюер проверит её и вернёт замечания. Вы просмотрите предложение
          и решите, сохранять ли результат.
        </p>
      </div>
      {serverMode === "mock" && (
        <div className="notice warning">
          Тестовый режим: ответы агентов имитируются. Облачные модели не вызываются.
        </div>
      )}
      {activeId && (
        <div className="notice warning">
          Сейчас выполняется другая задача.{" "}
          <button
            className="text-button"
            onClick={() => {
              // Открывает уже выполняющуюся задачу.
              selectTask(activeId);
            }}
          >
            Открыть её →
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          // Отправляет текст формы без перезагрузки страницы.
          e.preventDefault();
          if (!connectionReady || busy || activeId || !text.trim()) return;
          void create(text);
        }}
      >
        <label htmlFor="task-text">Что должна делать функция?</label>
        <textarea
          id="task-text"
          maxLength={MAX_TASK_CHARS}
          value={text}
          onChange={(e) => {
            // Сохраняет редактируемый текст только в форме.
            setText(e.target.value);
          }}
          placeholder="Например: объединить пересекающиеся интервалы, не изменяя исходный массив…"
        />
        <div className="composer-bottom">
          <small>
            TypeScript · {text.length.toLocaleString("ru-RU")} /{" "}
            {MAX_TASK_CHARS.toLocaleString("ru-RU")}
          </small>
          <button
            type="submit"
            className="primary"
            disabled={!connectionReady || busy || !text.trim() || Boolean(activeId)}
          >
            {busy ? "Создаём задачу…" : "Запустить агентов →"}
          </button>
        </div>
      </form>
      <div className="examples-title">
        <h3>Начните с примера</h3>
        <small className="muted">Можно отредактировать</small>
      </div>
      <div className="examples">
        {TASK_EXAMPLES.map((example, index) => (
          // Показывает пример для заполнения поля без автоматического запуска.
          <button
            key={example.id}
            className="example"
            onClick={() => {
              // Заполняет поле примером и возвращает фокус в редактор.
              chooseExample(example.text);
            }}
          >
            <small>0{index + 1} / ПРИМЕР</small>
            <strong>{example.title} ↗</strong>
            <p>{EXAMPLE_DESCRIPTIONS[index]}</p>
          </button>
        ))}
      </div>
      <button
        className="advanced-example"
        onClick={() => {
          // Заполняет форму сложным примером без запуска агентов.
          chooseExample(ADVANCED_EXAMPLE.text);
        }}
      >
        <strong>Сложный пример: расчёт корзины ↗</strong>
        <span>{ADVANCED_EXAMPLE.description}</span>
        <small>Заполнить поле задачи · запуск отдельной кнопкой</small>
      </button>
      <div className="flow-preview">
        <span>
          <b>01 · Автор</b>Функция и тестовые случаи
        </span>
        <span>
          <b>02 · Ревьюер</b>Проверка и доработка
        </span>
        <span>
          <b>03 · Применение</b>После вашего решения
        </span>
      </div>
      <p className="scope-note">
        Одна чистая синхронная функция с JSON-входом и результатом. Без сети, файлов и сторонних
        зависимостей. Для каждой задачи создаётся отдельная папка результата.
      </p>
    </>
  );
}
