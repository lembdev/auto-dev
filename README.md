# auto-dev

Установка для автономной разработки поверх Claude Code: Оркестратор берёт Готовые Задачи из GitHub Issues
одного Продукта, ведёт их через Конвейер Реализация -> QA -> Merge и показывает всё в веб-UI.
Термины: `GLOSSARY.md`. Контракт трекера и триажные метки: `docs/agents/`.

## Требования

- Node 22.13+ (используется `node:sqlite`), npm.
- Подписка Claude Max: Оркестратор отказывается стартовать, если в окружении или в файле env
  есть `ANTHROPIC_API_KEY` или `ANTHROPIC_AUTH_TOKEN`.

## Команды

```
npm ci            # зависимости (Agent SDK запинен в lockfile)
npm run build     # tsc -> dist/
npm test          # vitest: тесты на фейках портов и HTTP/WS
npm run typecheck # tsc --noEmit для src и test
npm run dev       # tsx watch src/main.ts
npm start         # node dist/main.js
```

## Конфигурация

Файл env (`KEY=VALUE`, путь из `AUTO_DEV_ENV_FILE`, по умолчанию `/etc/auto-dev/env`) читается первым,
переменные процесса перекрывают его.

| Переменная          | По умолчанию          | Назначение                                   |
| ------------------- | --------------------- | -------------------------------------------- |
| `AUTO_DEV_ENV_FILE` | `/etc/auto-dev/env`   | файл env с секретами Установки               |
| `AUTO_DEV_DATA_DIR` | `/var/lib/auto-dev`   | данные: `runtime.db`, клон Продукта `repo/` (клонируется на старте, если его нет) |
| `AUTO_DEV_HOST`     | `0.0.0.0`             | адрес HTTP-сервера                           |
| `AUTO_DEV_PORT`     | `8080`                | порт HTTP-сервера (`0` = свободный)          |
| `LOG_LEVEL`         | `info`                | уровень pino: fatal, error, warn, info, debug, trace, silent |
| `GITHUB_TOKEN`      | не задан              | fine-grained PAT Установки (Issues RW, Pull requests RW, Contents RW, Checks R, Commit statuses R, Metadata R) |
| `GITHUB_REPO`       | не задан              | Продукт в виде `owner/name`; без него и токена Оркестратор не стартует и только отдаёт API |

Настройки, которые меняются на ходу, лежат в таблице `installation` Рантайм-индекса:
`max_parallel_tasks` (Слоты, по умолчанию 2), курсоры опроса `poll.issues.since`, `poll.issues.etag`,
`poll.comments.since`, `poll.comments.etag`.

Логи: pino JSON в stdout.

## Локальный запуск

```
AUTO_DEV_DATA_DIR=./.data AUTO_DEV_ENV_FILE=./.data/env AUTO_DEV_PORT=8080 npm run dev
curl http://127.0.0.1:8080/api/health
curl http://127.0.0.1:8080/api/tasks   # Задачи в работе (ветка, PR, worktree), очередь Готовых, Тупики, Слоты
```

## Структура

- `src/ports/`: интерфейсы внешних зависимостей Оркестратора (GitHub, Драйвер, worktree, часы, процессы).
  Это единственный шов тестирования.
- `src/fakes/`: in-memory фейки портов с журналом вызовов `calls` и helpers `seed*` / `human*`.
- `src/adapters/`: реальные адаптеры Установки: GitHub REST, git (`worktree.ts`, через `child_process`;
  токен уходит в git через окружение), часы, процессы.
- `src/orchestrator/`: Оркестратор: опрос GitHub (issues и комментарии с `since` и ETag каждые 15 с),
  выбор Готовых Задач, взятие в Слоты, переходы Стадий; хуки `afterTake`, `onIssuesUpdated`, `onIssueComments`.
  `workspace.ts`: при взятии worktree `issue-<N>` (повтор `issue-<N>-r<k>`) в `<repo>/.claude/worktrees/`,
  ветка `worktree-<имя>` от `origin/main`, push и PR `WIP: <title>` с `Closes #N`.
  `intents.ts`: журнал намерений: внешнее действие записывается в `intents` до выполнения и отмечается
  после; незавершённые досовершаются на каждом цикле опроса идемпотентно (обработчик сам проверяет,
  что уже есть: worktree, ветка, PR по head-ветке, комментарий с маркером `<!-- auto-dev -->`).
  `comments.ts`: комментарии Оркестратора с маркером, по одному на ключ.
- `src/index/`: Рантайм-индекс (SQLite через `node:sqlite`), миграции только вперёд; таблицы `installation`,
  `tasks`, `transitions`, `intents`.
- `src/server/`: Hono + `ws` на одном http-сервере, `createApp(deps)` для тестов на фейках.
- `test/`: vitest, `test/helpers/test-app.ts` поднимает сервер на фейках.
