# Контур

Локальное приложение для разработки одной TypeScript-функции. Автор создаёт код, ревьюер проверяет его на другой модели, а применяющий агент сохраняет результат после подтверждения пользователя. React показывает задачи и переписку; Express обслуживает API; LangGraph управляет шагами и восстановлением.

## Материалы для сдачи

Актуальный [комплект сдачи](project-history/submission/README.md): [хендофф](project-history/submission/handoff.md), [план демонстрации на 20 минут](project-history/submission/demo.md), [журнал решений](project-history/submission/decisions.md), [три подлинных переписки с ИИ](project-history/submission/conversations/README.md). Подготовлен 28.09.2026 по истории обсуждений и коду `f537ce4`.

## Запуск

Среда: Node.js 26+, npm, Codex CLI 0.156.1 с выполненным входом через ChatGPT. Адаптер сейчас использует жёстко заданный путь `/opt/homebrew/bin/codex`; наличие CLI только в другом каталоге PATH недостаточно. Собственного экрана авторизации в приложении пока нет. Подробности и запуск без облачных моделей — в [хендоффе](project-history/submission/handoff.md).

```sh
npm ci
/opt/homebrew/bin/codex login status
npm start
```

Откройте <http://127.0.0.1:4317>. По умолчанию приложение вызывает настоящий Codex: автор и применяющий используют `gpt-6-sol`, ревьюер — `gpt-6-luna`. Вызовы расходуют лимиты аккаунта Codex. Адаптер проверяет версию CLI; обновление требует повторной проверки протокола.

1. Создайте задачу: опишите функцию или выберите пример.
2. Наблюдайте создание, проверки и замечания ревьюера.
3. Просмотрите код и подтвердите или отклоните конкретную версию.
4. После применения скачайте файлы или ZIP.

Поддерживаются чистые синхронные функции с JSON-входами и выходами. Проверки выполняются в QuickJS с ограничениями времени и памяти. Закрытие вкладки не останавливает сервер; Ctrl+C завершает сервер, следующий запуск восстанавливает сохранённые задачи.

## Структура

[История работы над проектом](project-history/README.md): задания, исследования, планы, согласованные решения и результаты проверок.

```text
src/
  client/
    api/          HTTP, схемы ответов и подписка на события
    hooks/        запросы, команды и обновление данных
    components/   интерфейс и локальное состояние форм
    workflow/     представление этапов и истории ревью
  shared/         общие API-схемы и примеры задач
  server/
    index.ts      запуск и завершение сервера
    app.ts        сборка Express-приложения
    config.ts     настройки и лимиты
    logger.ts     диагностический журнал
    routes/       API, SSE и выдача интерфейса
    tasks/        команды, состояние и шаги LangGraph
    codex/        адаптеры настоящего Codex и mock
    code-runner/  компиляция и исполнение в QuickJS
    storage/      файлы, JSONL и SQLite checkpoints
tests/
  unit/           отдельные правила модулей
  integration/    совместная работа сервера и хранилища
  e2e/            пользовательский путь в браузере
  live/           отдельные модельные прогоны
  support/        техническая подготовка и очистка
  fixtures/       входные данные тестов
```

Компоненты получают данные через hooks; TanStack Query хранит ответы и управляет обновлением. Изменяющие команды автоматически не повторяются. Сервер сохраняет попытку до вызова модели, а публикация проверяет одобренную версию и хеш файлов.

## Данные

Новая версия по умолчанию использует `.local-data/architecture-rework/` и начинает с пустого состояния. Старые базы автоматически не импортируются.

```text
.local-data/architecture-rework/
  checkpoints.sqlite
  server-events.jsonl
  tasks/<task-id>/
    revisions/<version-id>/
    result/
    events.jsonl
```

JSONL хранит историю задачи, SQLite — состояние выполнения LangGraph. Диагностический журнал сервера ограничен ротацией; полные задания и код в него не записываются. Для отдельного запуска задайте папку данных:

```sh
APP_DATA_DIR=.local-data/another-run APP_PORT=4318 npm start
```

## Проверки

```sh
npm run check          # ESLint, TypeScript, unit/integration и сборка
npm run format:check   # форматирование исходников и тестов
npm run test:e2e       # браузерный сценарий с mock
QA_REAL_CODEX=1 npm run test:e2e  # браузерный сценарий с настоящим Codex
npm run test:live-review        # смешанная проверка исправления ошибки
```

Mock-тесты дают воспроизводимые ответы, задержки и ошибки. Для ручного запуска:

```sh
APP_CODEX_MODE=mock APP_MOCK_SCENARIO=review_once APP_DATA_DIR=.local-data/mock-review npm start
```

Сценарии: `happy`, `review_once`, `review_loop`, `no_response`, `slow`. Режим показан в интерфейсе. В `review_once` первая версия — **замоканная версия с намеренной ошибкой**, затем адаптер возвращает исправленный вариант.

В `test:live-review` только первая версия замокана с намеренной ошибкой. Ревью, исправление и повторное ревью выполняет настоящий Codex; отчёт отмечает смешанное происхождение ответов. Этот прогон отдельно проверяет возврат замечаний автору.

[Правила чтения и запуска тестов](tests/README.md), [карта исходных сценариев](tests/scenario-map.md), [команды модельных проверок](project-history/architecture-rework/testing-guide.md).

## Решения и история

[Принятый план](project-history/architecture-rework/plan.md), [договорённости](project-history/architecture-rework/decisions.md), [состояние работы](project-history/architecture-rework/status.md), [результаты проверок](project-history/architecture-rework/verification.md).

Первая версия сохранена в ветке `codex/original-reference`, версия на Express — в `codex/express-migration`. Документы `project-history/two-model-loop/` и `project-history/express-migration/` содержат исторические решения и доказательства прежних прогонов. Актуальные команды новой версии находятся в этом README и документах `project-history/architecture-rework/`.

Правила разработки: [инструкции для агентов](AGENTS.md), [процесс разработки проекта](development-process.md).
