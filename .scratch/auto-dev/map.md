# Карта: auto-dev

Label: wayfinder:map
Tracker: local markdown (`.scratch/auto-dev/`), см. конвенции в skill setup-matt-pocock-skills / issue-tracker-local.md

## Destination

Спека и архитектура комплекса auto-dev (оркестратор + веб-UI + установщик для Proxmox), в которой не осталось нерешённых развилок. Дальше: /to-tickets и сборка. Сам комплекс и установщик строятся после карты, не внутри неё.

## Notes

- Домен: автономная разработка ПО поверх Claude Code на домашнем Proxmox. Референс flow: примеры Sandcastle (mattpocock/sandcastle), сам Sandcastle - библиотека-оркестратор песочниц, не продукт.
- Skills для сессий: /grilling, /domain-modeling (глоссарий в `GLOSSARY.md`), /research для research-тикетов, /prototype для прототипа UI.
- Язык общения: русский. Без длинных тире. Отчёты предельно сжато.
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

## Decisions so far

<!-- одна строка на закрытый тикет: гист + ссылка -->

- [Research: Claude Code Max на headless VM: auth, режимы запуска, лимиты](issues/01-max-subscription-headless.md) - путь: `claude setup-token` -> `CLAUDE_CODE_OAUTH_TOKEN`; `-p` stream-json/resume и Agent SDK работают под Max; `--bare` и Remote Control под токеном не работают; лимит детектируется по `rate_limit_event`; агенты только от non-root.
- [Research: GitHub-примитивы для задач: зависимости, sub-issues, milestones, события](issues/03-github-deps-subissues-events.md) - нативные зависимости и sub-issues работают в личных репо; готовность = `blocked_by == 0`; issue types только в org, значит labels; polling с ETag каждые 15-20 с; draft PR в приватном личном репо недоступен; GitHub App нужен, чтобы отличать бота от человека.
- [Research: как показывать живого агента и говорить с ним из веб-UI](issues/02-live-agent-view-options.md) - Agent SDK streaming input даёт и поток событий, и отправку сообщений в живую сессию; `-p stream-json` тот же протокол; Remote Control не встраивается и не работает под setup-token; tmux+ttyd только как запасной raw-режим; готовые UI как библиотека не переиспользуются; JSONL формат внутренний.
- [Research: как устроены Proxmox VE Community Scripts (установка и обновление)](issues/04-community-scripts-conventions.md) - движок в репо community-scripts/core, self-hosting через `COMMUNITY_SCRIPTS_URL` + пин core; обновление через `/usr/bin/update` -> `update_script()` + `fetch_and_deploy_gh_release`; unprivileged LXC достаточно; репо скриптов должен быть публичным; сервис запускать от non-root.
- [Драйвер агентов: Agent SDK, claude -p или Sandcastle](issues/05-agent-driver.md) - Agent SDK TS в streaming input mode, системный `claude` с автоапдейтом и smoke-query при смене версии; Сессия = идентичность Агента, процесс гасится в idle/Ожидании и поднимается через resume; bypassPermissions от non-root; ask_human = in-process MCP tool + PreToolUse defer (прототип 16); env Агента собирает оркестратор, старт запрещён при ANTHROPIC_API_KEY; полный gh у Агента, граница держится промптом.

- [Жизненный цикл задачи и словарь labels в GitHub](issues/06-task-lifecycle-labels.md) - пересмотрено 2026-11-05: словарь и структура как в Breedly/breedly-api: milestone = эпик с Epic/Spec/Task/Bug, opt-in `ready-for-agent`, нативные blocked_by, типы org-уровня; `queued` убран; своих меток auto-dev не заводит, стадия Конвейера только в Рантайм-индексе и UI, взятие видно по assignee; тупик = `ready-for-human`; закрытие через `Closes #N` + отметка критериев в Epic; веху закрывает Оркестратор; закрытие issue руками = отмена.

- [Research: обзор Codeman (Ark0N/Codeman): что переносимо в auto-dev](issues/17-codeman-takeaways.md) - как основа нет (скрейпинг терминала, `/clear`, нет GitHub-модели); берём: форму `rate_limits` и поведение у стены (в тикет 12), exactly-once доставку Ответа через `clientId`+`seq` и дедуп в Рантайм-индексе (в 07, 09, 08), раскладку worktree = `claude --worktree` (в 08), идеи UI (в 14, 15).

## Not yet specified
- Промпты стадий: за основу взять implement/review промпты Breedly (карта репо, что прочитать до правки, один тикет на ветку, вердикт {approved, blockers}), без SwiftUI-шагов.

- Уведомления вне браузера (Telegram/push) о ждущем агенте: пользователь сказал «не сейчас». Точка расширения в спеке, реализация позже.
- Содержимое промптов стадий (реализатор, QA, merge, планировщик): пишутся после того, как зафиксированы контракт задачи и механизм ask_human.
- Форма гостя и пользователь: unprivileged LXC (по research 04) и отдельный non-root user для сервиса и агентов (по research 01); публичный репо для скриптов установщика. Уточнить в тикете установщика/обновлений.
- Мастер первого запуска: какие шаги (репо, auth GitHub, auth Claude, лимиты), что хранится и где. Зависит от результата research по Max и от механизма установки.
- Секреты на VM (GitHub token, OAuth-токен Claude): где лежат файлы, из которых оркестратор собирает env Агента, как ротируются; `CLAUDE_CONFIG_DIR` Установки.
- Жизненный цикл worktree и ресурсов: когда удаляются worktree, ветки, зависшие процессы; что при переполнении диска; что чистится при отмене (issue закрыта руками) и при повторном `queued` после failed.
- Самохостинг: auto-dev разрабатывает сам себя. Ограничения и порядок bootstrap.
- Наблюдаемость: логи оркестратора, метрики расхода лимита подписки, история задач.

## Out of scope

- Несколько продуктов на одной VM (решено при составлении карты: одна VM = один продукт).
- Контейнерная изоляция каждого агента (решено: процессы + worktree).
- Поддержка других агентов (Codex и т.п.): только Claude Code.
