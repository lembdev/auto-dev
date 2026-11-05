# Карта: auto-dev

Label: wayfinder:map
Tracker: local markdown (`.scratch/auto-dev/`), см. конвенции в skill setup-matt-pocock-skills / issue-tracker-local.md

## Destination

Спека и архитектура комплекса auto-dev (оркестратор + веб-UI + установщик для Proxmox), в которой не осталось нерешённых развилок. Дальше: /to-tickets и сборка. Сам комплекс и установщик строятся после карты, не внутри неё.

## Notes

- Домен: автономная разработка ПО поверх Claude Code на домашнем Proxmox. Референс flow: примеры Sandcastle (mattpocock/sandcastle), сам Sandcastle - библиотека-оркестратор песочниц, не продукт.
- Skills для сессий: /grilling, /domain-modeling (глоссарий в `GLOSSARY.md`), /research для research-тикетов, /prototype для прототипа UI.
- Язык общения: русский. Без длинных тире. Отчёты предельно сжато.
- Решение пользователя 2026-11-05: агент применяет свои рекомендации без вопросов и закрывает все доступные тикеты за сессию; правки пользователь внесёт сам позже. HITL-тикеты резолвятся как AFK.
- Пользователь попросил писать проще: минимум собственных терминов, бытовые слова, короткие вопросы. Не перегружать варианты.
- Жёсткое ограничение: комплекс обязан работать под подпиской Claude Code Max (не API-ключ). Любое решение, требующее API-биллинга, недопустимо.
- Репозиторий комплекса: git@github.com:lembdev/auto-dev.git (личный, приватный; на 2026-11-05 пустой: без веток, milestones, issues, labels по умолчанию).
- Первый Продукт: Breedly/breedly-api (org, приватный). На 2026-11-05: 10 milestones «Эпик N: ...», Epic #1-#10 с критериями закрытия чек-листом, Spec #11-#14, Task #15-#65 с `ready-for-agent`, родитель = Epic (sub-issue), нативные blocked_by, типы issue org-уровня. Контракт трекера: `docs/agents/issue-tracker.md` в клоне `~/Developer/lembdev/Breedly/breedly-api` (2 коммита docs не запушены). Метка `check:acceptance` на #46 добавлена по ошибке и снимается, игнорировать.
- Постановка задач: /wayfinder, /to-spec, /to-tickets из mattpocock/skills поверх GitHub-трекера (конвенции в `~/.agents/skills/setup-matt-pocock-skills/issue-tracker-github.md`).
- Референс по статусам и промптам стадий: Breedly/breedly-ios (`docs/agents/issue-tracker.md`, `docs/adr/0024`, `.sandcastle/main.ts`, `implement-prompt.md`, `review-prompt.md`). Там однопоточный драйвер и SwiftUI-специфика (кадры, симулятор, a11y), брать общий концепт: веха = эпик, типы Epic/Spec/Task/Bug, `ready-for-agent`/`ready-for-human`, структурированный вердикт ревью, передача человеку комментарием.

### Зафиксировано при составлении карты (не тикеты)
- Контракт трекера Продукта = Breedly/breedly-api (`docs/agents/issue-tracker.md`): словарь меток, типы issue, структура milestone. auto-dev подстраивается под него, а не наоборот.

- Карта = спека, сборка после. «Plan, don't do» действует.
- Одна VM = один продукт (один GitHub-репозиторий). Новый продукт = новая VM через установщик.
- Изоляция агентов: процессы + git worktree внутри VM, без контейнеров, с полными правами. Граница безопасности - сама VM.
- Состояние: GitHub (issues, labels, milestones, PR) - единственная правда о задачах. Локально - только маленький индекс рантайма (задача -> стадия -> session id -> процесс -> worktree -> PR). Транскрипт - родные файлы сессий Claude Code, в БД не дублируется.
- Ожидание человека: процесс агента живёт, слот параллелизма освобождается, ответ из GitHub-комментария или UI попадает в ту же сессию.
- Конвейер: реализатор - одна живая сессия на всю жизнь задачи; QA - каждый раз новый инстанс; замечания QA уходят в сессию реализатора. Лимит кругов (по умолчанию 3), затем эскалация человеку стандартным механизмом.
- Запрос к человеку: специальный tool оркестратора (ask_human), одинаковый для всех стадий; комментарий в issue и label ставит оркестратор, не агент.
- Установщик: скрипт на хосте Proxmox в стиле community-scripts. Вопрос обновлений - тикет.
- Стек: TypeScript / Node. Имя комплекса: auto-dev.

## Выход карты

Спека опубликована: https://github.com/lembdev/auto-dev/issues/1 (2026-11-05, `ready-for-agent`). Дальше `/to-tickets 1`.

## Decisions so far

<!-- одна строка на закрытый тикет: гист + ссылка -->

- [Research: Claude Code Max на headless VM: auth, режимы запуска, лимиты](issues/01-max-subscription-headless.md) - путь: `claude setup-token` -> `CLAUDE_CODE_OAUTH_TOKEN`; `-p` stream-json/resume и Agent SDK работают под Max; `--bare` и Remote Control под токеном не работают; лимит детектируется по `rate_limit_event`; агенты только от non-root.
- [Research: GitHub-примитивы для задач: зависимости, sub-issues, milestones, события](issues/03-github-deps-subissues-events.md) - нативные зависимости и sub-issues работают в личных репо; готовность = `blocked_by == 0`; issue types только в org, значит labels; polling с ETag каждые 15-20 с; draft PR в приватном личном репо недоступен; GitHub App нужен, чтобы отличать бота от человека.
- [Research: как показывать живого агента и говорить с ним из веб-UI](issues/02-live-agent-view-options.md) - Agent SDK streaming input даёт и поток событий, и отправку сообщений в живую сессию; `-p stream-json` тот же протокол; Remote Control не встраивается и не работает под setup-token; tmux+ttyd только как запасной raw-режим; готовые UI как библиотека не переиспользуются; JSONL формат внутренний.
- [Research: как устроены Proxmox VE Community Scripts (установка и обновление)](issues/04-community-scripts-conventions.md) - движок в репо community-scripts/core, self-hosting через `COMMUNITY_SCRIPTS_URL` + пин core; обновление через `/usr/bin/update` -> `update_script()` + `fetch_and_deploy_gh_release`; unprivileged LXC достаточно; репо скриптов должен быть публичным; сервис запускать от non-root.
- [Драйвер агентов: Agent SDK, claude -p или Sandcastle](issues/05-agent-driver.md) - Agent SDK TS в streaming input mode, системный `claude` с автоапдейтом и smoke-query при смене версии; Сессия = идентичность Агента, процесс гасится в idle/Ожидании и поднимается через resume; bypassPermissions от non-root; ask_human = stdio MCP tool + in-process PreToolUse defer (поправка по прототипу 16 в Comments); env Агента собирает оркестратор, старт запрещён при ANTHROPIC_API_KEY; полный gh у Агента, граница держится промптом.

- [Жизненный цикл задачи и словарь labels в GitHub](issues/06-task-lifecycle-labels.md) - пересмотрено 2026-11-05: словарь и структура как в Breedly/breedly-api: milestone = эпик с Epic/Spec/Task/Bug, opt-in `ready-for-agent`, нативные blocked_by, типы org-уровня; `queued` убран; своих меток auto-dev не заводит, стадия Конвейера только в Рантайм-индексе и UI, взятие видно по assignee; тупик = `ready-for-human`; закрытие через `Closes #N` + отметка критериев в Epic; веху закрывает Оркестратор; закрытие issue руками = отмена.

- [Research: обзор Codeman (Ark0N/Codeman): что переносимо в auto-dev](issues/17-codeman-takeaways.md) - как основа нет (скрейпинг терминала, `/clear`, нет GitHub-модели); берём: форму `rate_limits` и поведение у стены (в тикет 12), exactly-once доставку Ответа через `clientId`+`seq` и дедуп в Рантайм-индексе (в 07, 09, 08), раскладку worktree = `claude --worktree` (в 08), идеи UI (в 14, 15).

- [Поток запроса к человеку: семантика ask_human и маршрутизация ответа](issues/07-human-request-flow.md) - ask_human = `question` + `options`, Ответ свободный текст; один комментарий-Запрос в issue Задачи; PAT + скрытый маркер `<!-- auto-dev -->` вместо GitHub App, Ответ = первый комментарий без маркера, реакция 🚀 как «принято»; Ответ из UI зеркалится в issue; первое полученное = Ответ, остальное = сообщения Диалога; таймаута нет; открытый Запрос и применённые Ответы живут в Рантайм-индексе.

- [Модель рантайм-состояния на VM и восстановление после рестарта](issues/08-runtime-state-model.md) - SQLite `/var/lib/auto-dev/runtime.db`, один писатель (Оркестратор), UI через API; таблицы tasks / agents / human_requests / applied_answers / pending_messages / installation / transitions; транскрипты и тексты вопросов не хранятся; старт = убить сирот по PID, resume всех не ждущих, сверка с GitHub по issue и PR, стадия только из индекса; всегда resume, 3 провала = тупик; внешние действия через намерения в индексе, досовершаются идемпотентно.

- [Стадия merge: метод слияния, конфликты, CI, закрытие issue и milestone](issues/11-merge-stage-policy.md) - squash через merge-async, сообщение = заголовок PR; вместо draft префикс `WIP:`; сливает Оркестратор по API, Merger-агент только при конфликте, после резолва ещё один Круг QA вне лимита; checks ждём, красный = Круг, висят час = тупик; issue закрывается явно, критерии Epic отмечаются по секции `## Критерии Epic` в теле PR; milestone с Epic и Spec закрывает Оркестратор, незакрытые критерии = `ready-for-human` на Epic; ветка на GitHub удаляется, Сессия Реализатора закрывается.

- [Живой вид агента и интерактивный диалог: выбранный подход](issues/09-live-view-interaction.md) - свой чат поверх SDK-потока; карточка Агента = лента событий с историей из sessionStore; в Ожидании блок Запроса с вариантами-кнопками; Диалог всегда доступен, очередь недоставленных видна и редактируема, доставка exactly-once; кнопки «Остановить ход» и «Отменить задачу».
- [Режим планирования: ход сессии и контракт выхода](issues/10-planning-mode-contract.md) - Планировщик = Сессия через Драйвер на клоне main без коммитов; промпт + skills wayfinder/to-spec/to-tickets + контракт трекера Продукта; выход = milestone, Epic с критериями, Spec, Task/Bug sub-issues с `ready-for-agent` и blocked_by; завершает человек кнопкой; сессию можно продолжить; дополнение поверх существующего; Оркестратор стартует сразу.
- [Параллелизм и поведение при исчерпании лимита подписки](issues/12-parallelism-and-limits.md) - `max_parallel_tasks` default 2, Слот = работает/idle; тумблер «Пауза»; у стены до resetsAt + 2 мин, живые гасятся как idle и поднимаются resume, ретрай 5 мин; расход из `rate_limit_event`, запасной statusline в настройках процесса Агента; пре-арм 95 %; подсветка 60/85 %.
- [Обновление уже развёрнутых установок auto-dev](issues/13-update-mechanism.md) - SemVer теги + GitHub Releases, репо публичный с первого релиза; `/opt/auto-dev/releases/<v>` + симлинк current; штатный `update_script()` + `/usr/bin/update`, кнопка в UI через sudo NOPASSWD; без автообновления, баннер раз в сутки; процедура Пауза -> дождаться Ходов -> stop -> deploy -> миграции -> start -> resume; rollback только при той же схеме; `claude` не откатываем.
- [Веб-UI: фреймворки, транспорт реального времени, доступ в LAN](issues/14-web-ui-stack-and-access.md) - один Node-процесс: Hono + WebSocket (`ws`) + REST; React + Vite + TS SPA, TanStack Query, Tailwind; `0.0.0.0:8080` без TLS, один пароль Установки, cookie 30 дней, проверка Origin/Host.
- [Жизненный цикл worktree, веток и процессов](issues/19-worktree-resource-lifecycle.md) - worktree `issue-<N>[-r<k>]`, ветка `worktree-issue-<N>`; после merge и при Отмене всё удаляется; в тупике всё остаётся до повторного запуска; чужие `claude` гасятся на старте и раз в час; диск >= 90 % = Пауза + баннер, автоудаления нет.
- [Установщик: форма гостя, конфиг, секреты и первый запуск](issues/20-installer-guest-config-secrets.md) - unprivileged LXC Debian 13, пользователь `auto-dev` без sudo; `/etc/auto-dev/env` 0600 с `AUTO_DEV_REPO`, `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, hash пароля; `CLAUDE_CONFIG_DIR=/var/lib/auto-dev/claude`; смена через «Настройки» с мягким перезапуском Агентов; мастер: пароль -> репо и token -> проверка -> OAuth -> smoke-query -> клон.
- [Самохостинг: auto-dev разрабатывает сам себя](issues/21-self-hosting-bootstrap.md) - до v0.1.0 руками в Claude Code с задачами в GitHub по тому же контракту; после - отдельная Установка на своей VM; обновление только релизами, никогда с main.
- [Наблюдаемость: логи, метрики лимита, статистика задач](issues/22-observability.md) - pino JSON в journald, уровень из env; снимки лимита раз в 10 мин в `limit_samples` на 30 дней; статистика из `transitions`; журнал в UI через `journalctl`; без Prometheus.

- [Прототип экрана режима разработки (дашборд агентов)](issues/15-dashboard-prototype.md) - прототип `research/15-dashboard/index.html`; выбрана раскладка A: шапка (Продукт, режимы, два лимита, Слоты, Пауза, Обновить), digest «С прошлого визита», одна колонка карточек Задач (В работе / Готовые / Тупики), панель Агента шторкой с лентой событий, блоком Запроса и Диалогом; на карточке в Ожидании виден текст Запроса.

- [Прототип: ask_human через PreToolUse defer и возврат Ответа при resume в Agent SDK](issues/16-defer-resume-prototype.md) - работает с оговорками: defer даёт `tool_deferred` и выход процесса; in-process MCP при resume не работает, нужен stdio MCP tool + in-process hook; Ответ едет через `allow` + `updatedInput` на тот же tool_use_id; resume только открытым streaming input без промпта; `disallowedTools` убирает AskUserQuestion; SIGTERM + `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` восстанавливает Ход; нужен `strictMcpConfig`. Скрипт `research/16-defer-resume/`.
- [Промпты Стадий: Реализация, QA, Merge](issues/18-stage-prompts.md) - промпты в auto-dev (`prompts/*.md`), Продукт влияет через свои CLAUDE.md/GLOSSARY/docs/agents/ADR; общая часть: worktree, один PR, без labels и статус-комментариев, вопросы только ask_human; Реализатор заполняет тело PR с `## Критерии Epic`; QA выдаёт JSON `{approved, summary, blockers}`; Merger только конфликты; Планировщик по контракту трекера; завис 30 мин = interrupt + resume, второй раз тупик.

## Not yet specified

(пусто: вся видимая дорога разложена на тикеты)

## Out of scope

- Уведомления вне браузера (Telegram/push) о ждущем Агенте: пользователь сказал «не сейчас». Точка расширения: внутренние события Оркестратора (Запрос, завершение, тупик) уже есть в `transitions` и WS; отдельный канал доставки - новая карта.
- Reverse proxy с TLS, QR-вход с телефона, несколько пользователей UI (решено в 14: один пароль, LAN без TLS).

- GitHub App для Оркестратора (решено в 07: PAT + скрытый маркер в комментариях; App вернётся только если понадобится отличать бота от человека иначе, чем маркером).

- Несколько продуктов на одной VM (решено при составлении карты: одна VM = один продукт).
- Контейнерная изоляция каждого агента (решено: процессы + worktree).
- Поддержка других агентов (Codex и т.п.): только Claude Code.
