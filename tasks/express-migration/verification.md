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

Исходный аудит маршрутов и ошибок выполнен по коду и Fastify 5.12.5. Для malformed JSON, превышения 1 MiB и unsupported Content-Type исходный custom error handler отдавал 500 `internal_error`; эта семантика внесена в матрицу и тесты.

Socket-тесты требуют разрешения на loopback в sandbox; без него `listen 127.0.0.1` выдаёт `EPERM` ещё до HTTP-логики. Платные live модели не запускались. Исторические отчёты исходной задачи не переписаны.
