# Готовая реализация

Основная рабочая папка: `/Users/lidia/Desktop/BIOSINGULARITY/agent-workspace`, ветка `main`. Изменения подготовлены в `codex/architecture-rework` от Express-версии и доставляются отдельным merge commit.

## Запуск

Прежний сервер Express продолжает работать на 4317. Для одновременного сравнения запустите новую версию на 4320:

```sh
cd /Users/lidia/Desktop/BIOSINGULARITY/agent-workspace
npm ci
APP_PORT=4320 npm start
```

Откройте <http://127.0.0.1:4320>. По умолчанию используется настоящий Codex с существующим входом ChatGPT. Новые задачи сохраняются в отдельной `.local-data/architecture-rework`; старые базы не подхватываются.

## Что изменилось

- API, управление данными и компоненты React разделены; TanStack Query хранит серверные данные.
- Сервер разделён на маршруты, операции задач, вызовы Codex, выполнение кода и хранение. История — JSONL, состояние графа — SQLite.
- Функции и callbacks пояснены по-русски. В тестах видны входы, действия и ожидаемые результаты.
- Mock-сценарии сохранены; ошибочная подготовленная версия явно названа замоканной версией с намеренной ошибкой.

Проверки и их ограничения находятся в [verification.md](verification.md); команды — в корневом README и tests/README.md.

## Сохранённые версии

- `codex/original-reference` → `78ee49d`: первая версия приложения.
- `codex/express-migration` → `04b956c`: версия после переноса на Express, её worktree остаётся на месте.
- `codex/architecture-rework`: новая реализация, отдельный worktree `/Users/lidia/.codex/worktrees/architecture-rework/agent-workspace`.

Ранние заметки обсуждения сохранены в Git stash `66cd0c4584b417cca8fb44d74df052ecabe04c37`. Прежние данные и рабочие документы не удалены: границы этой очистки требуют отдельного уточнения.
