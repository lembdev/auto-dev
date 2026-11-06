# auto-dev

Установка для автономной разработки поверх Claude Code: Оркестратор берёт Готовые Задачи из GitHub Issues
одного Продукта, ведёт их через Конвейер Реализация -> QA -> Merge и показывает всё в веб-UI.
Термины: `GLOSSARY.md`. Контракт трекера и триажные метки: `docs/agents/`.

## Установка на Proxmox VE

Одна команда в shell хоста Proxmox VE (от root) создаёт unprivileged LXC Debian 13 с Установкой:

```
bash -c "$(curl -fsSL https://raw.githubusercontent.com/lembdev/auto-dev/main/ct/auto-dev.sh)"
```

Требования: Proxmox VE 8.0+ или 9.x, root-shell на хосте, доступ в интернет во время установки, публичный
релиз `lembdev/auto-dev` на GitHub (скрипт ставит последний). Контейнер по умолчанию: 4 vCPU, 8 GB RAM,
40 GB диска, DHCP; всё это меняется в диалоге «Advanced Install» ct-скрипта. Движок установщика: Proxmox VE
Community Scripts (`community-scripts/core`, MIT), запинен в `ct/auto-dev.sh` по SHA; наши скрипты
`ct/auto-dev.sh` и `install/auto-dev-install.sh` берутся из `main` этого репозитория.

Что делает установщик внутри контейнера:

- ставит git, `gh` (из GitHub Releases `cli/cli`), Node 22 LTS (NodeSource), `sudo`, `jq`;
- создаёт пользователя `auto-dev` (без sudo, кроме NOPASSWD на `/usr/bin/update` и `journalctl -u auto-dev`,
  плюс группа `systemd-journal` для чтения журнала из UI) и ставит ему `claude` native installer
  (`https://claude.ai/install.sh`), который обновляет себя сам;
- раскладка: `/opt/auto-dev/releases/<версия>` плюс симлинк `/opt/auto-dev/current` (код, владелец root),
  `/var/lib/auto-dev` (`runtime.db`, клон Продукта `repo/`, `claude/` как `CLAUDE_CONFIG_DIR`; владелец `auto-dev`),
  `/etc/auto-dev` (владелец `auto-dev`, файл `env` 0600 создаёт мастер первого запуска);
- systemd unit `auto-dev.service` из `deploy/auto-dev.service` (User=auto-dev, Restart=always, логи в journald,
  `Environment=` для путей; секреты процесс читает из `/etc/auto-dev/env` сам), включён и запущен, так что
  Установка поднимается после перезагрузки контейнера; sudo-правила из `deploy/auto-dev.sudoers`;
- `/usr/bin/update` (генерирует движок): в консоли контейнера `update` или с хоста `pct exec <ctid> -- update`
  скачивает свежий ct-скрипт и выполняет его `update_script()`. Тот скачивает новый релиз (если он новее
  установленного; повторный `update` на той же версии ничего не делает) и запускает из него
  `deploy/auto-dev-update.sh install`: Пауза с источником `update` и ожидание текущих Ходов до 10 минут, затем
  `interrupt()` (через `node dist/main.js prepare-update` и локальный токен `/var/lib/auto-dev/update.token`),
  stop, релиз в `releases/<версия>`, миграции Рантайм-индекса вперёд (`node dist/main.js migrate`; индекс новее
  кода отказывает, и сервис стартует на прежнем релизе), переключение `current` (прежний остаётся как `previous`),
  unit, sudo-правила, start. Новая версия на старте снимает Паузу обновления и возобновляет оборванные Ходы.
  `/var/lib/auto-dev` и `/etc/auto-dev` не трогаются;
- `update --rollback` (обёртка `/usr/local/bin/update` из `deploy/update`, стоит в PATH раньше движковой):
  возвращает `current` на `previous`, только если версия схемы прежнего релиза
  (`node dist/main.js schema-version`) равна версии Рантайм-индекса (`schema-version --db`); иначе отказ с
  пояснением, потому что миграции идут только вперёд;
- раз в сутки сервер смотрит последний релиз `lembdev/auto-dev` на GitHub; если он новее, в шапке UI баннер
  «Доступна версия X» с кнопкой «Обновить», которая запускает тот же `update` через
  `sudo -n systemd-run --unit=auto-dev-update ... /usr/bin/update` (отдельный unit, чтобы stop сервиса не убил
  апдейтер). Автообновления нет.

После установки откройте `http://<ip контейнера>:8080`: первый вход показывает мастер первого запуска (см. ниже),
после него Оркестратор начинает брать Задачи. Логи: `journalctl -u auto-dev -f`.

## Релизы

Версия приложения живёт в `package.json` и отдаётся в `GET /api/health`. Релиз: поднять версию, закоммитить,
поставить тег `vX.Y.Z` (ровно `v` + версия из `package.json`) и запушить его. Workflow
`.github/workflows/release.yml` по тегу делает `npm ci`, typecheck, build, test, собирает архив
`auto-dev-X.Y.Z.tar.gz` (`scripts/package-release.sh`: `dist/`, `prompts/`, `deploy/`, `package.json`,
`package-lock.json`, `README.md` и production `node_modules` через `npm ci --omit=dev --omit=optional`) и
публикует GitHub Release с этим архивом; тег с суффиксом (`v1.2.0-rc1`) публикуется как pre-release, установщик
берёт только релиз, помеченный latest. Архив не зависит от платформы сборки: argon2 несёт prebuilds для linux
x64 и arm64 внутри пакета, а платформенные бинарники `claude` из optional-зависимостей Agent SDK не нужны, потому
что Установка запускает системный `claude`. Локально: `npm run build && scripts/package-release.sh --out release`.

## Требования (локальная разработка)

- Node 22.13+ (используется `node:sqlite`), npm.
- Подписка Claude Max: Оркестратор отказывается стартовать, если в окружении или в файле env
  есть `ANTHROPIC_API_KEY` или `ANTHROPIC_AUTH_TOKEN`.

## Команды

```
npm ci            # зависимости (Agent SDK запинен в lockfile)
npm run build     # tsc -> dist/ и vite -> dist/client (бандл UI)
npm test          # vitest: тесты на фейках портов и HTTP/WS (проект server) и компонентов UI в jsdom (проект client)
npm run typecheck # tsc --noEmit для src, test и client
npm run dev       # tsx watch src/main.ts (API и WS; статика только из собранного dist/client)
npm run dev:client # vite dev server клиента на :5173 с прокси /api и /ws на :8080
npm start         # node dist/main.js
npm run password-hash -- <пароль>  # argon2-хеш для AUTO_DEV_PASSWORD_HASH
```

## Первый запуск и Настройки

Пока файла env нет или в нём не хватает секретов, UI на `:8080` показывает мастер первого запуска:
пароль -> репозиторий и GitHub token -> проверка доступа -> OAuth-токен Claude (`claude setup-token`
на машине человека) -> smoke-query -> клон Продукта -> готово. Каждый шаг сразу пишется в файл env
(права 0600), мастер возобновляется с недоделанного шага после рестарта, а по завершении Оркестратор
начинает опрос без ручного рестарта. API мастера: `GET /api/setup` (публичный статус) и
`POST /api/setup/{password,repository,access,oauth,smoke,clone}` (до появления пароля публичны).

Страница «Настройки» (`GET/PUT /api/settings`) меняет `max_parallel_tasks`, пре-арм и лимит Кругов
(значения в `installation`, применяются с ближайшего цикла) и секреты: GitHub token (после проверки
доступа), OAuth-токен (после smoke-query; Пауза из-за истёкшего токена снимается) и пароль. Смена
секрета переписывает файл env, новые процессы получают новый env, живые Агенты гасятся по концу Хода
и поднимаются через resume при следующем сообщении.

## Конфигурация

Файл env (`KEY=VALUE`, путь из `AUTO_DEV_ENV_FILE`, по умолчанию `/etc/auto-dev/env`) читается первым,
переменные процесса перекрывают его. Мастер и Настройки переписывают файл сами; руками его править
не обязательно.

| Переменная          | По умолчанию          | Назначение                                   |
| ------------------- | --------------------- | -------------------------------------------- |
| `AUTO_DEV_ENV_FILE` | `/etc/auto-dev/env`   | файл env с секретами Установки               |
| `AUTO_DEV_DATA_DIR` | `/var/lib/auto-dev`   | данные: `runtime.db`, клон Продукта `repo/` (клонируется на старте, если его нет) |
| `AUTO_DEV_HOST`     | `0.0.0.0`             | адрес HTTP-сервера                           |
| `AUTO_DEV_PORT`     | `8080`                | порт HTTP-сервера (`0` = свободный)          |
| `AUTO_DEV_PASSWORD_HASH` | не задан         | argon2-хеш пароля Установки; задаётся мастером первого запуска (или `npm run password-hash`), без него UI ведёт в мастер |
| `AUTO_DEV_ALLOWED_HOSTS` | пусто            | дополнительные значения `Host` (через запятую, порт не важен) кроме встроенных безопасных: IP-литералы, `localhost`, имена без точки, `*.local` |
| `LOG_LEVEL`         | `info`                | уровень pino: fatal, error, warn, info, debug, trace, silent |
| `CLAUDE_CONFIG_DIR` | `<data dir>/claude`   | каталог Claude Code Установки: сессии Агентов, credentials  |
| `AUTO_DEV_CLAUDE_PATH` | ищется в `PATH`    | путь к системному `claude`                   |
| `CLAUDE_CODE_OAUTH_TOKEN` |                 | токен подписки из `claude setup-token`, уходит Агентам |
| `GH_TOKEN`          | = `GITHUB_TOKEN`      | токен GitHub, уходит Агентам для `gh`        |
| `GITHUB_TOKEN`      | не задан              | fine-grained PAT Установки (Issues RW, Pull requests RW, Contents RW, Checks R, Commit statuses R, Metadata R) |
| `GITHUB_REPO`       | не задан              | Продукт в виде `owner/name`; без него и токена Оркестратор не стартует, UI ведёт в мастер |

Настройки, которые меняются на ходу, лежат в таблице `installation` Рантайм-индекса:
`max_parallel_tasks` (Слоты, по умолчанию 2), `max_qa_rounds` (лимит Кругов QA, по умолчанию 3), курсоры опроса
`poll.issues.since`, `poll.issues.etag`, `poll.comments.since`, `poll.comments.etag`.

Логи: pino JSON в stdout.

## Доступ к UI

HTTP без TLS на `AUTO_DEV_HOST:AUTO_DEV_PORT`, один общий пароль Установки. `POST /api/login` с `{password}` ставит
cookie `auto_dev_session` на 30 дней (HttpOnly, SameSite=Lax; подпись HMAC секретом из `installation.session.secret`,
смена секрета разлогинивает всех). Без cookie любой `/api/*` и `/ws` отвечают 401, кроме `/api/health`, `/api/session`
и `/api/login`. Защита от DNS rebinding: `Host` каждого запроса и `Origin` апгрейда WS должны быть IP-адресом,
`localhost`, именем без точки, `*.local` или значением из `AUTO_DEV_ALLOWED_HOSTS`; иначе 403.

API Режима разработки: `GET /api/tasks` (В работе с состоянием Агента и открытым Запросом, Готовые, Тупики),
`GET /api/installation`, `PUT /api/installation/pause` и `POST /api/installation/claude/recheck`,
`GET /api/digest?since=<ISO>` («С прошлого визита»: Запросы,
завершённые Задачи и Тупики после `since`; отметку визита клиент хранит в localStorage). `GET /ws` шлёт события
`transition`, `task`, `agent`, `request`, `installation` при изменениях индекса; клиент по ним перечитывает данные.

Панель Агента: `GET /api/tasks/:issue/agent/history` отдаёт транскрипт Сессии Агента текущей попытки (из
`getSessionMessages` SDK, только `user`/`assistant`) и `cursor`: номер последнего сообщения в памяти Оркестратора,
которое история уже содержит. Клиент шлёт в `/ws` кадр `{type: "subscribe", agentId, after: cursor}` и получает
события `agent-message` `{agentId, seq, message}` с `seq > after`: сначала хвост из буфера (последние 4000 сообщений
каждого Агента, включая `stream_event`), затем живой поток без дублей и пропусков; `{type: "unsubscribe", agentId}`
снимает подписку. `POST /api/tasks/:issue/agent/interrupt` прерывает Ход работающего Агента (`interrupt()`, Сессия
остаётся; у idle/waiting/stopped 409). `POST /api/tasks/:issue/cancel` закрывает issue (`not_planned`) и сразу
применяет Отмену, не дожидаясь опроса (у Задачи вне Конвейера и не в Тупике 409).

Диалог и Ответ из UI: кадры идут по `/ws`: `{type: "answer", clientId, seq, requestId, text}` отвечает на открытый
Запрос, `{type: "dialogue", clientId, seq, issueNumber, text}` отправляет сообщение Агенту Задачи. На каждый кадр
сервер отвечает тому же сокету `{type: "ack", clientId, seq, watermark, outcome, reason}`: `applied` (принято),
`duplicate` (этот `seq` уже видели, не применён) или `rejected` (отказано навсегда: пустой текст, неизвестная Задача
или Запрос, Ответ после того, как Запрос уже ответили из GitHub; в последнем случае текст уходит в Диалог).
`clientId` хранится в localStorage вкладки, `seq` только растёт; водяной знак каждого клиента и очередь
`pending_messages` лежат в Рантайм-индексе, так что рестарт Оркестратора ничего не теряет и не дублирует. Ответ из
UI делает resume Сессии и зеркалится в issue комментарием с маркером (`**Ответ из UI**`); побеждает Ответ, полученный
раньше, а комментарии человека в issue после Ответа становятся сообщениями Диалога. Сообщение Диалога во время Хода
встаёт в очередь и уходит в ту же Сессию после конца Хода (Реализатору: Задача возвращается в Реализацию, начатый
Круг QA гасится); idle-Агент получает его сразу, остановленному Сессия возобновляется с сообщением как промптом.
`GET /api/tasks/:issue/dialogue` отдаёт очередь «ещё не доставлено», `DELETE /api/tasks/:issue/dialogue/:id` убирает
сообщение до доставки (409, если уже доставлено); событие `dialogue` `{issueNumber, messageId, state}` сообщает об
изменениях очереди. Клиент записывает кадр в localStorage до отправки и удаляет по ACK; раз в 2 с проверяет, что
самый старый кадр ждёт ACK не дольше 4 с, иначе переподключает сокет и шлёт всё заново.

Режим планирования (переключатель в шапке): `GET /api/planner` отдаёт `{status, open, canResume, agent, sessionId,
queue}`; `POST /api/planner/start {mode: "resume"|"new", message?}` запускает Планировщика: Сессию Драйвера с ролью
`planner` на самом клоне Продукта (`fetch`, затем `checkout -B main origin/main`; не worktree), с промптом
`prompts/plan.md` или resume последней Сессии (её session id хранится в `installation` под `planner.last_session`).
Планировщик вне Слотов и одновременно только один: второй старт 409, resume без прошлой Сессии 404.
`POST /api/planner/finish` гасит процесс, Сессия остаётся для следующего «продолжить прошлую»;
`POST /api/planner/interrupt` прерывает Ход. Сообщения Планировщику идут тем же кадром Диалога с адресом вместо
issue: `{type: "dialogue", to: "planner", clientId, seq, text}`; `clientId` и `seq` общие с Диалогом, поэтому тот же
водяной знак даёт exactly-once и тот же `ack` (`rejected`, если планирование не начато). Строки, набранные во время
Хода, ждут его конца в памяти Оркестратора (`queue`, `DELETE /api/planner/queue/:id`); строка к погашенному по
idle процессу возобновляет Сессию. Лента: `GET /api/planner/history` (как история Агента Задачи) и `subscribe` по
`agentId`; событие `planner` сообщает об изменениях. `ask_human` Планировщику не дан: он спрашивает в Диалоге.
На Паузе, у стены лимита, на пре-арме и при заблокированной версии Claude Code старт Планировщика отвечает 409 с
причиной, а строки к нему копятся в очереди до цикла, на котором новые Ходы снова разрешены.
Созданные им Задачи с `ready-for-agent` Оркестратор берёт на следующем опросе.

Страница «Статистика» (ссылка в шапке): `GET /api/stats?days=7|30` считает из `transitions` Задач взято, влито,
Тупиков, среднее и медианное время Стадий и распределение Кругов QA по завершённым Задачам; `GET /api/stats/limits?days=`
отдаёт снимки `limit_samples` за период для графика лимита; `GET /api/logs?lines=500` отдаёт последние строки журнала
Оркестратора: из `journalctl -u auto-dev` под systemd (нужен NOPASSWD-доступ к журналу), иначе из кольцевого буфера
процесса (последние 500 строк pino).

## Отступления от спеки

- Строка Диалога Реализатору, пока Задача в `qa`, гасит начатый Круг QA и возвращает Задачу в Реализацию: правка человека важнее проверки устаревшего кода.
- Скрипт обновления ходит в `POST /api/installation/prepare-update` и `GET /api/installation` с заголовком `Authorization: Bearer <токен>` вместо cookie: токен Оркестратор пишет на старте в `<data dir>/update.token` (права 0600), другие маршруты он не открывает.
- `Host` и `Origin` проверяются эвристикой против DNS rebinding (IP, `localhost`, имя без точки, `*.local`); иное имя Установки добавляется в `AUTO_DEV_ALLOWED_HOSTS`.

## Требования к окружению Планировщика

Skills `/wayfinder`, `/to-spec` и `/to-tickets` Установщик не ставит. Чтобы Планировщик вёл планирование через них, их нужно положить в `CLAUDE_CONFIG_DIR` Установки (`<data dir>/claude/skills`); без них Планировщик делает те же шаги сам по промпту.

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

Дрейф версии `claude` (`src/orchestrator/claude-version.ts`): last-known-good версия лежит в `installation`
(`claude.last_known_good`); на каждом цикле опроса, до старта любого нового Агента, версия читается один раз и при
смене делает один smoke-query под OAuth Установки. Успех записывает версию, провал (`claude.smoke_failure`)
запрещает новых Агентов (`blocker: claude_version`), живые Сессии не трогает и отдаёт в `GET /api/installation`
поле `claudeVersion` с ошибкой и командой отката `claude install <lastKnownGood>`; повтор только при новой смене
версии, по `POST /api/installation/claude/recheck` или после smoke-query с новым токеном в Настройках. Отклонённый
OAuth-токен (`api_retry` с `authentication_failed`) включает Паузу с источником `token`; баннер в шапке ведёт в
Настройки, где новый токен снимает её.

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
  Взятие пишет Задачу (`taken`), переход и намерение `take` (assignee, снятие `ready-for-agent`) одной транзакцией
  до первого вызова GitHub; сбой или рестарт посередине досовершает журнал, а workspace готовится на следующем цикле.
  `workspace.ts`: при взятии worktree `issue-<N>` (повтор `issue-<N>-r<k>`) в `<repo>/.claude/worktrees/`,
  ветка `worktree-<имя>` от `origin/main`, пустой коммит `chore: start work on <title>` (только если в ветке
  ещё нет своих коммитов: GitHub не открывает PR без коммитов), push и PR `WIP: <title>` с `Closes #N`.
  `intents.ts`: журнал намерений: внешнее действие записывается в `intents` до выполнения и отмечается
  после; незавершённые досовершаются на каждом цикле опроса идемпотентно (обработчик сам проверяет,
  что уже есть: worktree, ветка, PR по head-ветке, комментарий с маркером `<!-- auto-dev -->`).
  `comments.ts`: комментарии Оркестратора с маркером, по одному на ключ.
  `implementation.ts`: Стадия Реализации: после подготовки workspace Реализатор стартует через `AgentRunner`
  в worktree Задачи (`taken -> implement`), одна Сессия на всю попытку, следующие сообщения (`send`) идут в
  живой процесс или через `resume` того же session id; конец Хода без `tool_deferred` переводит Задачу в `qa`.
  Ход с error-result (не лимит) получает в ту же Сессию «Продолжай.», второй такой Ход подряд = Тупик.
  Слот занимает Задача в активной Стадии, чей Агент работает или idle (только что взятая без Агента тоже);
  ждущий и остановленный Слот не занимают. `epic.ts`: родительская issue (sub-issue или `Part of #N`)
  и её чек-лист критериев.
  `human-requests.ts`: Запросы к человеку. Первый вызов `ask_human` hook отвечает `defer`; по результату
  Хода с `tool_deferred` пишется строка `human_requests` и ровно один комментарий-Запрос с маркером в issue
  Задачи (Стадия, вопрос, варианты, «ответьте комментарием здесь или в UI»); Агент ждёт без таймаута, Слот
  свободен. Ответ = первый комментарий без маркера после Запроса от любого пользователя: на него ставится
  реакция `rocket`, Сессия возобновляется открытым потоком без промпта, hook на тот же `tool_use_id`
  отвечает `allow` с текстом Ответа и строкой «кто и откуда» (ссылка на комментарий). Применённые Ответы
  лежат в `applied_answers` по идентичности источника (`source_kind` + `source_id`: id комментария, позже
  `clientId:seq` из UI); повтор, правка и удаление комментария ничего не меняют. На старте открытые Запросы
  сверяются с комментариями issue, так что Ответ, пришедший во время простоя, не теряется. Пока новые Ходы
  запрещены (Пауза, у стены, пре-арм), принятый Ответ ждёт в памяти и доставляется на первом разрешённом цикле.
  Ждущий Агент, получив Ответ, снова занимает Слот даже сверх `max_parallel_tasks`: начатые Задачи важнее
  новых, а новые взятия ждут, пока занятость не опустится.
  `qa.ts`: Стадия QA: на каждый Круг новый QA-Агент с чистой Сессией в worktree (промпт `qa` с прошлым
  вердиктом); Круг стартует сразу после Хода Реализатора и на каждом цикле опроса для Задач в `qa` без
  Круга (рестарт, снятая Пауза), но не пока `Orchestrator.canStartTurn()` ложен. Вердикт (`verdict.ts`):
  ровно один JSON `{approved, summary, blockers:[{where, what}]}` в последнем сообщении, `approved` только
  при пустых `blockers`. Blockers уходят в живую Сессию Реализатора (`qa -> implement`, `round + 1`),
  approved переводит в `merge`. Нераспарсенный вердикт: просьба выдать только JSON в ту же QA-Сессию
  (она уже сделала проверку), вторая неудачная попытка подряд = Тупик; Ход QA с ошибкой = новая Сессия, вторая ошибка
  подряд = Тупик. Круг `round + 1 >= max_qa_rounds` с blockers = Тупик (`stuck`): `ready-for-human`,
  снятый assignee и комментарий-причина с маркером `stuck:<attempt>` одним намерением `dead-end`, Агенты
  остановлены, Слот свободен, worktree и ветка остаются. QA-Агент в Ожидании (вызвал `ask_human`) остаётся
  Агентом Круга: новый Круг не стартует, Ответ возобновляет его Сессию. Прошлый вердикт и текущий Круг живут в
  памяти: после рестарта QA-Агент Круга, поднятый recovery или ждущий Ответа, снова становится Кругом, иначе
  Задача в `qa` получает свежий Круг без прошлого вердикта.
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
  `epic-closure.ts`: после merge, когда issue Задачи закрыта, одно намерение `settle-epic`: строки секции
  `## Критерии Epic` тела PR (без маркеров списка и чекбоксов, «нет» = ничего) отмечаются `[x]` в теле Epic
  при точном совпадении с чек-листом, несовпавшие не трогаются, тело правится только при изменениях. Затем
  сверка вехи: все issues вехи, кроме Epic и Spec, закрыты и все критерии Epic отмечены = закрываются Epic,
  Spec и веха; issues закрыты, а критерии нет = на Epic `ready-for-human` и комментарий со списком
  неотмеченных (один на набор критериев, маркер `epic-unchecked:<hash>`), веха остаётся открытой. Раз в 10 минут
  открытые вехи влитых Задач проходят ту же сверку, так что веху закрывает и ручная отметка критериев человеком,
  и закрытая им последняя issue. Epic =
  родитель Задачи (sub-issue или `Part of #N`); с типами issue (org) Epic и Spec узнаются по типам `Epic` и
  `Spec`, без типов Spec = issue вехи рядом с Epic без родителя, без `ready-for-agent` и не бывшая Задачей.
  Веха без Epic закрывается, когда закрыты все её issues, чужие issues при этом не трогаются. Задача без
  вехи и без родителя сверку не запускает.
  Все переходы видны в `transitions` и в `GET /api/tasks` (`transitions` у каждой Задачи, список `cancelled`).
  `recovery.ts`: рестарт безопасен. На первом цикле все PID из `agents` считаются сиротами (SIGTERM, 10 с,
  SIGKILL живым), чужие процессы `claude` пользователя `auto-dev` вне индекса (и не потомки Оркестратора
  или его Агентов) гасятся так же, и повторно раз в час; под другим системным пользователем чужие процессы
  не трогаются. Затем сверка с GitHub по каждой Задаче в активной Стадии или в Тупике (одна issue и один PR):
  issue закрыта без влитого PR = Отмена, PR влит руками = переход в `merge` и штатное завершение Стадией
  Merge, сбитые assignee и `ready-for-agent` восстанавливаются; Стадия берётся только из индекса. После
  досовершения намерений поднимаются Агенты, чей Ход оборвал рестарт (`running` в индексе или остановленные
  штатным shutdown посреди Хода): `resume` того же session id с `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`,
  ждущие не поднимаются, idle и остановленные ждут следующего сообщения. Поднимаются все не ждущие Агенты:
  Реализатор, QA-Агент Круга (его вердикт принимается как обычно), Merger (конец его Хода даёт дополнительный
  Круг) и Планировщик, который снова становится единственным открытым; QA, Merger и Планировщик без session id
  не поднимаются, вместо них Стадия стартует свежего. Список на подъём и счётчик провалов подряд лежат в `installation`
  (`restart.resume`, `restart.resume_failures`): три провала подряд (ошибка запуска, выход процесса или
  error-result до первого сообщения) = Тупик, рабочая Сессия сбрасывает счётчик; пока новые Ходы запрещены
  (Пауза, у стены), подъём ждёт. Зависание: Агент в Ходе без событий 30 мин получает `interrupt()`, SIGTERM и
  `resume` с «Продолжай.»; второй раз подряд = Тупик; завершённый Ход сбрасывает счёт. Результат с
  `terminal_reason` прерванного Хода (`turns.ts`) Стадии не считают концом Хода.
- `prompts/`: промпты Стадий текстом (`common.md` плюс `implement.md`, `qa.md`, `merge.md`, `plan.md`);
  `src/prompts/` собирает общую часть и часть Стадии с подстановками `{{issue_number}}`, `{{issue_title}}`,
  `{{issue_body}}`, `{{epic}}`, `{{pull_number}}`, `{{branch}}`, `{{worktree}}`, `{{round}}`,
  `{{previous_verdict}}`, `{{stage}}`; `plan.md` самостоятелен (без общей части) и знает только `{{repo_path}}` и
  `{{base_branch}}`. Каталог читается из корня пакета и в dev, и из `dist/`, поэтому
  в сборку ничего копировать не нужно; Продукт промпты не переопределяет, а влияет через свои `CLAUDE.md`,
  `GLOSSARY.md`, `docs/agents` и `docs/adr`, которые промпт обязывает прочитать.
- `src/index/`: Рантайм-индекс (SQLite через `node:sqlite`), миграции только вперёд; таблицы `installation`,
  `tasks`, `transitions`, `agents`, `intents`, `human_requests`, `applied_answers`.
- `src/server/`: Hono + `ws` на одном http-сервере, `createApp(deps)` для тестов на фейках; `auth.ts`: сессии,
  проверка `Host` и `Origin`; `api-types.ts`: типы ответов, общие с клиентом; статика `dist/client` с fallback на
  `index.html`.
- `client/`: SPA (React, Vite, TanStack Query, Tailwind): вход, шапка с лимитами, Слотами и Паузой,
  «С прошлого визита», карточки В работе / Готовые / Тупики, панель Агента с лентой и Диалогом, экран Режима
  планирования на тех же ленте и поле Диалога; обновление по WS плюс опрос.
- `test/`: vitest, `test/helpers/test-app.ts` поднимает сервер на фейках; `test/installer/` проверяет скрипты
  установщика (`bash -n`, shellcheck, если он есть в PATH), unit и sudo-правила из `deploy/` и состав архива релиза.
- `ct/`, `install/`: Установщик в стиле Proxmox VE Community Scripts (ct-скрипт с `update_script()` и install-скрипт,
  который исполняется внутри контейнера); `deploy/`: systemd unit и sudo-правила, попадают в архив релиза;
  `scripts/package-release.sh`: сборка архива; `.github/workflows/release.yml`: публикация релиза по тегу.
