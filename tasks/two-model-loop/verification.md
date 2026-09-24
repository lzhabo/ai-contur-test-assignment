# Проверки реализации

24.09.2026. Базовые документы: `d30c919`; эксперименты E0: `4c11be9`; общие контракты и первый UI: `fcfac02`.

Это фактический журнал разработки. Независимая приёмка интегрированного приложения ещё не выполнена; A-01–A-10 пока не закрыты полностью.

## E0 — совместимость

| Проверка | Результат | Доказательство / граница |
|---|---|---|
| Исходник без изменений | PASS | SHA-256 совпадает с brief.md |
| Реальная история Git | PASS | Документы, эксперименты и основа приложения зафиксированы разными коммитами |
| Облачные вызовы Sol и Luna | PASS в пределах CLI-наблюдений | tests/unit/codex/E0-REPORT.md и e0-sol/e0-luna.jsonl. Explicit CLI --model, exit 0, turn.completed; backend model ID в JSONL не возвращается, self-report модели не считается независимым подтверждением |
| SQLite между процессами, interrupt/resume | PASS | tests/unit/workflow/e0-evidence.md: authorCalls=1 после нового процесса и Command.resume |
| Durable intent и бюджет до side effect | PASS | Отдельное SQLite-соединение читает сохранённые attemptId и reservedCalls внутри probe до вызова автора |
| Отмена дерева процессов | PASS для локального probe | tests/unit/codex/cancel-process-group.probe.mjs: parent и grandchild завершены |
| Read-only как изоляция чтения | FAIL, подход отвергнут | e0-archive-access.jsonl и e0-image-access.jsonl: внешний текст/PNG прочитаны |
| Конфигурация Codex с отключёнными инструментами | PASS для проверенных каналов CLI 0.156.1 | e0-no-tools.jsonl не раскрыл text/PNG; e0-sol-no-tools.jsonl вернул структурированный ответ. Все flags и ограничения в E0-REPORT.md; будущие версии требуют проверки |
| QuickJS / TS чистая функция | PASS | tests/unit/checks/quickjs-e0.probe.ts: результат 5, остановка infinite loop, 64 MiB OOM, нет host API, node:fs import отклонён |

## E1 — общая основа и UI

- Node 26.9.0, TypeScript 5.9.3; точные зависимости в package-lock.json. TypeScript 7.0.2 отвергнут из-за отсутствия нужного transpileModule API.
- `npm run typecheck` и `npm run build` — PASS на основе E1 с UI.
- `APP_PORT=4320 APP_DATA_DIR=.local-data/ui-smoke node --import tsx src/server/main/index.ts`: E1 сервер запущен после разрешённой эскалации loopback listen (sandbox EPERM).
- В настоящем браузере открыта главная страница, пустой ввод отключает запуск. Выбор первого примера заполнил поле (609 символов), задач осталось 0. Это только UI smoke, не полный сценарий агентов.
- `python3 tests/fixtures/validate.py` — PASS структуры независимых fixtures QA. Сгенерированный код этим скриптом не исполняется.

## E2 — разработка

QA запускает проверки по мере появления модулей. Их промежуточные результаты не являются окончательной приёмкой; после интеграции требуется freeze commit и повтор независимых сценариев.

## Материалы

В delivery/conversations/ три подлинных фрагмента пользовательских сообщений и ответов ассистента из локального журнала текущей задачи. Записи скопированы побайтно, тексты не переписаны; служебные события и tool outputs не включены. README и sha256.json фиксируют границы экспорта и хеши. Проверка распространённых credential patterns не нашла совпадений; это не универсальное доказательство отсутствия секретов.
