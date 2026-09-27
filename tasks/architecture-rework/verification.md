# Проверка исходного состояния

27.09.2026. Проверена Express-база `04b956c`, Node `v26.9.0`, установленные зависимости.

| Проверка | Результат текущей сессии |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | Не стартовал: sandbox запретил запись временной конфигурации в `node_modules/.vite-temp` |
| `npm test -- --configLoader native --no-cache` | 75/87 PASS; 16/19 файлов PASS; 12 тестов заблокированы `listen EPERM 127.0.0.1` либо последующим timeout |
| Git status Express после проверок | Чистый, HEAD и ветка не изменились |

Заблокированные группы: `tests/integration/http-events.test.ts` — 5, `tests/integration/http-frontend.test.ts` — 4, `tests/unit/workflow/sse-lifecycle.test.ts` — 3. Четыре unhandled errors также относятся к `listen EPERM`. Прогон не установил новый дефект приложения и не доказывает прохождение этих 12 тестов.

Сборка, E2E и реальные модели в этой сессии не запускались. Исторические 87/87, build PASS и E2E 1/1 приведены в Express-worktree в `tasks/express-migration/verification.md`; это отдельные, ранее полученные доказательства.

## Регрессия для будущего плана

- Сценарии команды/повторы/гонки: `service.test.ts`, `service-process.test.ts`.
- Перезапуск, checkpoint и неизвестный исход: `process-restart.test.ts`, `graph-recovery.test.ts`, `service-guards.test.ts`.
- Файлы, хеши и журнал: `artifacts.test.ts`, `event-recovery.test.ts`, `local-store.test.ts`.
- Изоляция вычислений и Codex: `quickjs-runner.test.ts`, `checks.test.ts`, `cli-port.test.ts`.
- Наблюдаемость: `checkpoint-observability.test.ts`, `demo-observability.test.ts`, `observability.test.ts`.
- HTTP/SSE/SPA: три перечисленные выше группы, требующие доступного loopback.
- UI: `workflow.test.tsx`, `tests/e2e/product-flow.spec.ts`.

Некоторые тесты recovery намеренно используют `graph.updateState`, имена узлов, `.values.value` и прямой `SqliteSaver`. Их обвязку можно адаптировать к внутренним интерфейсам workflow, сохраняя проверки аварийных границ. Тесты подмены файлов обоснованно знают структуру хранилища.

## Переименование тестового режима в mock

Новая ветка codex/architecture-rework, база 04b956c и согласованное переименование исходников, тестов и документации.

| Проверка | Результат |
| --- | --- |
| npm run typecheck | PASS |
| npm test -- --configLoader native --no-cache | PASS: 19 файлов, 87 тестов, 9.49 с; доступ к loopback разрешён для этого прогона |
| npm run build | PASS: Vite, 116 модулей |
| git diff --check | PASS |
| Поиск прежнего термина в src, текущих tests и README | Совпадений нет; исторические свидетельства не переписывались |

Настоящие модели и смешанная live-проба в этом подшаге не запускались. Проба проверена TypeScript и чтением изменений; новое облачное доказательство не заявляется. Обе исходные версии сохранены.

Независимое review: одна находка — README предлагал старую инструкцию запуска. Добавлена актуальная testing-guide.md, прежняя ссылка явно архивная. Production/test код после успешного прогона не менялся. Других находок reviewer нет.
