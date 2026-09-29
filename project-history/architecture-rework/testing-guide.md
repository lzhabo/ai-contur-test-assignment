# Проверки с mock и настоящим Codex

Команды выполняются в новой рабочей копии `/Users/lidia/.codex/worktrees/architecture-rework/agent-workspace`.

## Mock-сценарии

```sh
npm run check
npm run format:check
npm run test:e2e
APP_CODEX_MODE=mock APP_MOCK_SCENARIO=review_once APP_DATA_DIR=.local-data/mock-review npm start
```

`review_once` использует замоканную версию с намеренной ошибкой, замоканное замечание ревьюера и исправленную замоканную версию. Настоящие модели в этом режиме не вызываются. Другие значения APP_MOCK_SCENARIO: happy, review_loop, no_response, slow.

## Настоящие модели

```sh
codex login status
APP_CODEX_MODE=real APP_DATA_DIR=.local-data/real-run npm start
```

Приложение использует существующий вход Codex через ChatGPT. Эта папка данных отделена от mock-прогона.

Браузерный сценарий с настоящими моделями запускается командой `QA_REAL_CODEX=1 npm run test:e2e`. Полный набор проверок: `npm run check:full`. Реальные прогоны расходуют лимиты текущей подписки; при недоступности доступа прогон отмечается как заблокированный, без автоматической подмены ответов.

## Смешанная проверка исправления

```sh
npm run test:live-review
```

Первая версия — **замоканная версия с намеренной ошибкой** (`mockedIncorrectCandidate`). Первый ревьюер, исправляющий автор и повторный ревьюер вызываются через настоящий Codex. Отчёт содержит `executionKind: mixed`, `firstVersionSource: mocked-incorrect-author-version` и источник каждого ответа. Это проверка возврата замечаний и исправления с заранее подготовленным первым дефектом.

Исторические инструкции в project-history/two-model-loop и project-history/express-migration описывают прежние версии; для новой ветки используются команды этой страницы.
