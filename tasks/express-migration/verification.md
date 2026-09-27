# Проверка переноса

Исходная версия: `78ee49ded1ff5726962ee4ce3e992470d8f6593d`.

| Этап | Команда / метод | Результат |
| --- | --- | --- |
| До переноса, typecheck | `npm run typecheck` после `npm ci` | PASS |
| До переноса, tests | `npm test` | 76/79 PASS; 3 socket-теста блокировал `listen EPERM` в sandbox |
| После переноса, typecheck | `npm run typecheck` | PASS |
| После переноса, tests | `npm test` с loopback-разрешением | PASS: 19 файлов, 85 тестов |
| После переноса, build | `npm run build` | PASS: Vite, 116 модулей |
| HTTP/SPA smoke | Отдельный процесс `src/server/main/index.ts`, `APP_CODEX_MODE=fake`, все пять `APP_FAKE_SCENARIO`; API create/read/decision/stop/ZIP, `/`, unknown API, SIGTERM, restart с той же папкой | PASS: `happy`, `review_once`, `review_loop`, `no_response`, `slow`; временные папки удалены после проверки |
| Браузерный E2E | Локальный `happy` backend, `npx playwright test --config tests/e2e/playwright.config.ts` | PASS: UI создаёт задачу, показывает роли, восстанавливает страницу, подтверждает версию и скачивает ZIP |
| UI smoke всех fake-сценариев | Установленный Playwright/Chrome, отдельные временные серверы и папки данных; запуск задачи через UI, отображение fake-режима и ролей, отсутствие pageerror, SIGTERM | PASS: `happy`, `review_once`, `review_loop`, `no_response`, `slow` |

Исходный аудит маршрутов и ошибок выполнен по коду и Fastify 5.12.5. Для malformed JSON, превышения 1 MiB и неподдерживаемого Content-Type исходный custom error handler отдавал 500 `internal_error`; `text/plain` и валидные JSON-скаляры доходили до Zod и давали 400 `invalid_request`. После независимого ревью парсеры Express уточнены и контрактные тесты расширены. Источник: [Fastify content type parser](https://fastify.dev/docs/v5.12.x/Reference/ContentTypeParser/).

Socket-тесты требуют разрешения на loopback в sandbox; без него `listen 127.0.0.1` выдаёт `EPERM` ещё до HTTP-логики. Платные live модели не запускались. Исторические отчёты исходной задачи не переписаны.

Независимый reviewer на `84e0197` нашёл три расхождения парсеров (`text/plain`, JSON-скаляры, `application/*+json`) и риск symlink в `dist`; исправления внесены после первого коммита. QA на `84e0197` подтвердил 85/85 тестов, typecheck и build. Повторные проверки после исправлений: typecheck, 87/87 тестов, build и браузерный E2E 1/1. Два теста подтверждают, что symlink на asset или fallback index за пределами `dist` не отдаёт файл.

Повторные независимые QA и reviewer на `de3c2bd` подтвердили исправление этих дефектов и не нашли новых production-дефектов. QA отдельно прогнал 12 адресных тестов и браузерный E2E 1/1. Reviewer отметил переносимость E2E при переопределении ID моделей; селекторы теста исправлены, E2E 1/1 прошёл также с `AUTHOR_MODEL=custom-author`, `REVIEWER_MODEL=custom-reviewer`, `APPLIER_MODEL=custom-applier`.
