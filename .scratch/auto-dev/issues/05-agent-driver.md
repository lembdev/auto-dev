# Драйвер агентов: Agent SDK, claude -p или Sandcastle

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Через что оркестратор запускает и ведёт инстансы Claude Code, с учётом ограничения «только подписка Max»? Варианты: Claude Agent SDK (TypeScript), сырой claude -p с stream-json и --resume, Sandcastle как библиотека. Критерии: работа под Max, возможность отправлять сообщения в живую сессию, кастомный tool ask_human, resume после рестарта оркестратора, стоимость поддержки. Рекомендация будет после research 01 и 02.

## Notes

- Из research 01: оба пути (SDK и `-p`) работают под `CLAUDE_CODE_OAUTH_TOKEN`; `--bare` под OAuth не работает и может стать default для `-p`; на VM не должно быть `ANTHROPIC_API_KEY`.
- Из research 02: SDK streaming input = один долгоживущий процесс на Агента, follow-up в живую сессию, `interrupt()`, `canUseTool`; `-p stream-json` тот же протокол, но control-протокол не задокументирован; `sessionStore` официальный tap для истории. Рекомендация research: SDK.

## Answer

Решено 2026-11-04 (grilling).

1. **Драйвер: Claude Agent SDK (TypeScript)**, `query()` в streaming input mode. Сырой `claude -p` и Sandcastle отклонены. Sandcastle, для справки, сам запускает `claude -p --output-format stream-json` как shell-команду на итерацию, парсит stdout в 5 типов событий, не умеет отправлять сообщения в живую сессию и ожидает auth только через env (API key); модель «процесс на итерацию» противоречит нашей «одна живая сессия Реализатора».
2. **Бинарь: системный `claude`**, передаётся через `pathToClaudeCodeExecutable`; автообновление Claude Code оставлено включённым. Защита от дрейфа (`--bare` как будущий default `-p`, смена control-протокола): оркестратор хранит last-known-good `claude --version`; при смене версии перед стартом первого нового Агента выполняет smoke-query под OAuth; провал = новые Агенты не стартуют, Установка показывает ошибку в UI, живые сессии не трогаются. SDK пинится в lockfile как обычная зависимость.
3. **Сессия = идентичность Агента, процесс взаимозаменяем.** Агент идентифицируется session id Claude Code. Процесс `claude` живёт пока идёт ход и idle-таймаут после него (настройка, default 10 мин); в Ожидании процесс гасится; продолжение всегда через `resume: sessionId`. Рестарт оркестратора: все живые Агенты поднимаются `resume` с `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`. Остановка процесса: `interrupt()` затем SIGTERM, не голый SIGTERM посреди хода.
4. **Permissions: `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`**, сервис и Агенты от non-root (иначе bypass отказывает). Встроенный `AskUserQuestion` исключён через `disallowedTools`: единственный канал вопросов к человеку - ask_human.
5. **ask_human = in-process MCP tool (`createSdkMcpServer`) + `PreToolUse` hook с решением `defer`.** Ход завершается с `stop_reason: tool_deferred`, процесс можно гасить; при Ответе оркестратор делает `resume`, и Ответ приходит Агенту как результат того же вызова ask_human. Семантика вопроса/ответа - тикет 07. Механика defer -> resume -> подстановка результата в SDK нигде не показана на примере: нужен прототип (тикет 16).
6. **Env Агента собирает оркестратор явно** (опция `env` SDK заменяет окружение): `PATH`, `HOME`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` Установки, `CLAUDE_CODE_RETRY_WATCHDOG=1`, `GH_TOKEN`. Оркестратор отказывается стартовать, если в его собственном окружении есть `ANTHROPIC_API_KEY` или `ANTHROPIC_AUTH_TOKEN` (защита от API-биллинга). `cwd` = worktree Задачи.
7. **GitHub у Агента: полный `gh` с токеном оркестратора.** Граница «labels и комментарии-статусы ставит оркестратор» держится промптом Стадии, без технического запрета; оркестратор при polling сверяет labels с Рантайм-индексом и восстанавливает своё состояние, если Агент его сбил.
8. **События для UI**: поток `SDKMessage` с `includePartialMessages: true` и `forwardSubagentText`; история и восстановление через `sessionStore` / `getSessionMessages`. JSONL-файлы напрямую не парсятся.

Последствия для карты: разблокированы 07, 08, 09; заведён тикет 16 (прототип defer+resume); фог «риск `--bare`» закрыт пунктом 2; фог «Секреты на VM» сузился до «где лежат токены, которые оркестратор кладёт в env».

## Comments
- 2026-11-05, поправка по прототипу 16: п.5 читать как «ask_human = stdio MCP tool (тонкий процесс-эхо) + in-process `PreToolUse` hook в Оркестраторе». In-process `createSdkMcpServer` при resume не работает (`tool_deferred_unavailable`). Ответ доставляется при resume через `allow` + `updatedInput: {...input, answer}` на тот же `tool_use_id`; resume отложенного вызова только streaming input с открытым генератором и без промпта. Обязателен `strictMcpConfig: true`; в `env` Агента нужны полные PATH и HOME.
