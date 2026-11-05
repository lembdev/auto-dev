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
| `AUTO_DEV_DATA_DIR` | `/var/lib/auto-dev`   | данные: `runtime.db`, клон Продукта          |
| `AUTO_DEV_HOST`     | `0.0.0.0`             | адрес HTTP-сервера                           |
| `AUTO_DEV_PORT`     | `8080`                | порт HTTP-сервера (`0` = свободный)          |
| `LOG_LEVEL`         | `info`                | уровень pino: fatal, error, warn, info, debug, trace, silent |

Логи: pino JSON в stdout.

## Локальный запуск

```
AUTO_DEV_DATA_DIR=./.data AUTO_DEV_ENV_FILE=./.data/env AUTO_DEV_PORT=8080 npm run dev
curl http://127.0.0.1:8080/api/health
```

## Структура

- `src/ports/`: интерфейсы внешних зависимостей Оркестратора (GitHub, Драйвер, worktree, часы, процессы).
  Это единственный шов тестирования.
- `src/fakes/`: in-memory фейки портов с журналом вызовов `calls` и helpers `seed*` / `human*`.
- `src/adapters/`: реальные адаптеры Установки.
- `src/index/`: Рантайм-индекс (SQLite через `node:sqlite`), миграции только вперёд.
- `src/server/`: Hono + `ws` на одном http-сервере, `createApp(deps)` для тестов на фейках.
- `test/`: vitest, `test/helpers/test-app.ts` поднимает сервер на фейках.
