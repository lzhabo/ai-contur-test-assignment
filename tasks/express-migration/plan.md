# План и матрица совместимости

Версия: Express 5.2.1, `@types/express` 5.0.6. Express 5 поддерживает отклонения Promise в async handlers и Node 18+, что совместимо с требованием проекта Node 26. Источники: [Express error handling](https://expressjs.com/en/guide/error-handling/), [Express FAQ](https://expressjs.com/en/starter/faq/), [релизы](https://github.com/expressjs/express/releases).

| Контракт Fastify | Перенос Express | Проверка |
| --- | --- | --- |
| `GET /api/health`: `ok`, executionMode; `GET /api/tasks`: список | Router в `src/server/http/app.ts`, сервис остаётся источником данных | HTTP integration, smoke |
| `POST /api/tasks`: Zod, 202, Idempotency-Key, лимит одной активной задачи | Типизированный async route вызывает `service.createTask` | HTTP integration, service tests |
| `GET /api/tasks/:id`; POST decision/stop/resume: прежние DTO, коды и проверки версии/retry | Прямые вызовы типизированного сервиса, общий error middleware | HTTP integration, service tests |
| Origin у изменяющих методов: только `http://localhost` или `127.0.0.1` с тем же Host | Middleware перед JSON parser и маршрутами | HTTP integration |
| Ошибки: ServiceError→код/сообщение; Zod→400; внутренние и ошибки parser→500 без утечки | Последний error middleware | HTTP integration |
| JSON и text/plain до 1 MiB; текст и JSON-скаляры доходят до Zod (400), malformed JSON и неподдерживаемый Content-Type дают `internal_error` 500 в старом custom handler | `express.json`/`express.text` и проверка content type; ошибки идут в middleware | HTTP integration |
| HEAD для GET, пустое тело | Автоматический HEAD Express | HTTP integration |
| SSE: task и cursor до headers, Last-Event-ID выше after, connected, heartbeat 15 с, replay/live без дублей | Stream с subscribe-before-replay и очередью; cleanup при close/error/shutdown | HTTP integration, lifecycle |
| Artifact plain text, download=1; результат ZIP бинарный | `res.send` для текста/Buffer с прежними headers | HTTP integration, artifact tests |
| Неизвестный `/api/`→JSON 404; dist file MIME, SPA fallback, 503 без сборки, containment | Явный fallback в main, без express.static | HTTP/static smoke |
| Bind 127.0.0.1, port/data/mode env; SIGINT/SIGTERM и startup failure закрывают lock/logger/streams | Node `http.Server`, идемпотентный close | lifecycle + signal tests |

Порядок: исходные проверки; перенос зависимостей и app/main; тесты HTTP/SSE; typecheck, полный unit/integration, build, smoke fake сценариев; фиксированный коммит; независимый QA и reviewer; исправление замечаний и финальная верификация.

Владение файлами: координатор — `src/server/http/app.ts`, `src/server/main/index.ts`, `package*.json`, `README.md`, `tasks/express-migration/*`; implementer/QA — только `tests/integration/http-events.test.ts`, `tests/unit/workflow/sse-lifecycle.test.ts`; независимый аудитор и reviewer — чтение.
