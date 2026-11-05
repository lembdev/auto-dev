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
| `CLAUDE_CONFIG_DIR` | `<data dir>/claude`   | каталог Claude Code Установки: сессии Агентов, credentials  |
| `AUTO_DEV_CLAUDE_PATH` | ищется в `PATH`    | путь к системному `claude`                   |
| `CLAUDE_CODE_OAUTH_TOKEN` |                 | токен подписки из `claude setup-token`, уходит Агентам |
| `GH_TOKEN`          |                       | токен GitHub, уходит Агентам для `gh`        |
| `GITHUB_TOKEN`      | не задан              | fine-grained PAT Установки (Issues RW, Pull requests RW, Contents RW, Checks R, Commit statuses R, Metadata R) |
| `GITHUB_REPO`       | не задан              | Продукт в виде `owner/name`; без него и токена Оркестратор не стартует и только отдаёт API |

Настройки, которые меняются на ходу, лежат в таблице `installation` Рантайм-индекса:
`max_parallel_tasks` (Слоты, по умолчанию 2), `max_qa_rounds` (лимит Кругов QA, по умолчанию 3), курсоры опроса
`poll.issues.since`, `poll.issues.etag`, `poll.comments.since`, `poll.comments.etag`.

Логи: pino JSON в stdout.

## Локальный запуск

```
AUTO_DEV_DATA_DIR=./.data AUTO_DEV_ENV_FILE=./.data/env AUTO_DEV_PORT=8080 npm run dev
curl http://127.0.0.1:8080/api/health
curl http://127.0.0.1:8080/api/tasks   # Задачи в работе (Стадия, Круг, ветка, PR, worktree), очередь Готовых, Тупики и Отменённые с причиной, переходы, Слоты, лимит Кругов
```

## Драйвер Агентов

`src/adapters/driver.ts` реализует порт Драйвера поверх Claude Agent SDK: один `query()` в streaming
input mode на процесс Агента, системный `claude`, `bypassPermissions` (от root запуск отклоняется),
`disallowedTools: ["AskUserQuestion"]`, `strictMcpConfig`. Окружение Агента собирается строго из
`PATH`, `HOME`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `GH_TOKEN` плюс `CLAUDE_CODE_RETRY_WATCHDOG=1`
(`src/adapters/agent-env.ts`). Tool `ask_human` живёт в отдельном stdio MCP-процессе
(`src/adapters/ask-human-mcp.ts`), решение defer / allow принимает hook `PreToolUse` через `onAskHuman`
из порта. История Сессии читается через `getSessionMessages` SDK и отдаётся как `user` / `assistant`
сообщения `SDKMessage`; системные записи транскрипта опускаются.

`src/agents/agent-runner.ts` ведёт процессы поверх порта и таблицу `agents`: работает во время Хода,
idle после него до таймаута 10 мин (затем процесс гасится, Сессия жива), ждёт после отложенного
`ask_human`, остановлен без процесса. Сообщения и смены состояния уходят подписчикам.

Ручной smoke под подпиской Max (вне CI, запускает настоящий `claude`):

```
npm run smoke:driver -- start                      # промпт, сообщение в живой поток, stop
npm run smoke:driver -- ask                        # ask_human отложен, процесс вышел
npm run smoke:driver -- resume <sessionId> blue    # resume с открытым потоком, Ответ доставлен
npm run smoke:driver -- interrupt                  # stop() посреди Хода: interrupt, затем SIGTERM
npm run smoke:driver -- idle                       # AgentRunner гасит процесс по idle-таймауту
```

## Структура

- `src/ports/`: интерфейсы внешних зависимостей Оркестратора (GitHub, Драйвер, worktree, часы, процессы).
  Это единственный шов тестирования.
- `src/fakes/`: in-memory фейки портов с журналом вызовов `calls` и helpers `seed*` / `human*`.
- `src/adapters/`: реальные адаптеры Установки (GitHub REST, Драйвер на Agent SDK, stdio-сервер `ask_human`,
  git в `worktree.ts` через `child_process` с токеном через окружение, часы, процессы).
- `src/agents/`: жизненный цикл процессов Агентов поверх порта Драйвера и таблица `agents`.
- `src/orchestrator/`: Оркестратор: опрос GitHub (issues и комментарии с `since` и ETag каждые 15 с),
  выбор Готовых Задач, взятие в Слоты, переходы Стадий; хуки `afterTake`, `onIssuesUpdated`, `onIssueComments`.
  `workspace.ts`: при взятии worktree `issue-<N>` (повтор `issue-<N>-r<k>`) в `<repo>/.claude/worktrees/`,
  ветка `worktree-<имя>` от `origin/main`, push и PR `WIP: <title>` с `Closes #N`.
  `intents.ts`: журнал намерений: внешнее действие записывается в `intents` до выполнения и отмечается
  после; незавершённые досовершаются на каждом цикле опроса идемпотентно (обработчик сам проверяет,
  что уже есть: worktree, ветка, PR по head-ветке, комментарий с маркером `<!-- auto-dev -->`).
  `comments.ts`: комментарии Оркестратора с маркером, по одному на ключ.
  `implementation.ts`: Стадия Реализации: после подготовки workspace Реализатор стартует через `AgentRunner`
  в worktree Задачи (`taken -> implement`), одна Сессия на всю попытку, следующие сообщения (`send`) идут в
  живой процесс или через `resume` того же session id; конец Хода без `tool_deferred` переводит Задачу в `qa`.
  Слот занимает Задача в активной Стадии, чей Агент работает или idle (только что взятая без Агента тоже);
  ждущий и остановленный Слот не занимают. `epic.ts`: родительская issue (sub-issue или `Part of #N`)
  и её чек-лист критериев.
  `qa.ts`: Стадия QA: на каждый Круг новый QA-Агент с чистой Сессией в worktree (промпт `qa` с прошлым
  вердиктом); Круг стартует сразу после Хода Реализатора и на каждом цикле опроса для Задач в `qa` без
  Круга (рестарт, снятая Пауза), но не пока `Orchestrator.canStartTurn()` ложен. Вердикт (`verdict.ts`):
  ровно один JSON `{approved, summary, blockers:[{where, what}]}` в последнем сообщении, `approved` только
  при пустых `blockers`. Blockers уходят в живую Сессию Реализатора (`qa -> implement`, `round + 1`),
  approved переводит в `merge`. Нераспарсенный вердикт: просьба выдать только JSON в ту же QA-Сессию
  (она уже сделала проверку), второй провал подряд = Тупик; Ход QA с ошибкой = новая Сессия, вторая ошибка
  подряд = Тупик. Круг `round + 1 >= max_qa_rounds` с blockers = Тупик (`stuck`): `ready-for-human`,
  снятый assignee и комментарий-причина с маркером `stuck:<attempt>` одним намерением `dead-end`, Агенты
  остановлены, Слот свободен, worktree и ветка остаются. Прошлый вердикт и текущий Круг живут в памяти:
  после рестарта Задача в `qa` получает свежий Круг без прошлого вердикта.
  `reconcile.ts`: сверка по обновлениям issues из опроса. Отмена: issue Задачи в активной Стадии или в
  Тупике закрыта без влитого PR (`merged` у PR проверяется) = `cancelled`, Агенты остановлены, PR закрыт,
  remote-ветка, worktree и локальная ветка удалены; сама issue не трогается (ни комментария, ни меток).
  Повторное открытие issue ничего не запускает: Задача Готова снова только с новой меткой `ready-for-agent`,
  и тогда берётся как новая попытка. Восстановление: у Задачи в активной Стадии снятый человеком assignee
  возвращается, а возвращённая `ready-for-agent` снимается, молча, в том же цикле опроса. Задачу в Тупике
  Оркестратор не восстанавливает: её метки и assignee у человека. Возврат из Тупика = штатное взятие по
  `ready-for-agent` (attempt + 1, `issue-<N>-r<k>`, чистая Сессия, новый PR `WIP:`); при взятии снимается и
  `ready-for-human`, а старый PR, worktree и ветка убираются перед подготовкой новых.
  `cleanup.ts`: уборка следов попытки одним намерением `cleanup-workspace` (PR закрывается, если открыт;
  remote-ветка, worktree, локальная ветка удаляются, если есть); переиспользуется после merge.
  Все переходы видны в `transitions` и в `GET /api/tasks` (`transitions` у каждой Задачи, список `cancelled`).
- `prompts/`: промпты Стадий текстом (`common.md` плюс `implement.md`, `qa.md`, `merge.md`, `plan.md`);
  `src/prompts/` собирает общую часть и часть Стадии с подстановками `{{issue_number}}`, `{{issue_title}}`,
  `{{issue_body}}`, `{{epic}}`, `{{pull_number}}`, `{{branch}}`, `{{worktree}}`, `{{round}}`,
  `{{previous_verdict}}`, `{{stage}}`. Каталог читается из корня пакета и в dev, и из `dist/`, поэтому
  в сборку ничего копировать не нужно; Продукт промпты не переопределяет, а влияет через свои `CLAUDE.md`,
  `GLOSSARY.md`, `docs/agents` и `docs/adr`, которые промпт обязывает прочитать.
- `src/index/`: Рантайм-индекс (SQLite через `node:sqlite`), миграции только вперёд; таблицы `installation`,
  `tasks`, `transitions`, `agents`, `intents`.
- `src/server/`: Hono + `ws` на одном http-сервере, `createApp(deps)` для тестов на фейках.
- `test/`: vitest, `test/helpers/test-app.ts` поднимает сервер на фейках.
