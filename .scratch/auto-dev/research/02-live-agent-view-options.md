# Live view агентов Claude Code и отправка сообщений в сессию из web UI

Дата: 2026-11-04. Проверено на Claude Code 2.1.318 (локально) и Agent SDK TS 0.3.318 (npm). Источники: официальная документация code.claude.com, support.claude.com, исходники и README репозиториев на GitHub, npm-пакет SDK, локальные файлы `~/.claude`.

Вопрос: какими способами можно показать живую сессию Claude Code и разговаривать с ней из собственного web UI на Linux VM, где auto-dev запускает несколько агентов параллельно в git worktrees под подпиской Max.

## Выводы для auto-dev

1. **Основной вариант: Agent SDK (TypeScript) в streaming input mode, один долгоживущий процесс `claude` на агента, хост-процесс = auto-dev.** Это единственный официально поддерживаемый способ, который даёт одновременно: структурированный поток событий (`SDKMessage`, включая `stream_event` с токенами, `tool_use`/`tool_result`, статусы фоновых задач), отправку follow-up сообщений в работающую сессию (`streamInput()` / async-generator в `prompt`, поле `priority: "now" | "next" | "later"`), прерывание (`interrupt()`), а также перехват permission prompt и `AskUserQuestion` через `canUseTool` (callback «может висеть бесконечно», пока человек не ответит). SDK сам запускает бинарь `claude -p --input-format stream-json --output-format stream-json`, то есть это тот же протокол, что в пункте 3, но с готовым клиентом. Источники: [streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [user-input](https://code.claude.com/docs/en/agent-sdk/user-input), [typescript reference](https://code.claude.com/docs/en/agent-sdk/typescript).
2. **Подписка Max и SDK: работает технически, но юридически серая зона.** Support-статья от 15.06.2026: «Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits» (изменения приостановлены). Страница legal: OAuth-логин «intended exclusively for purchasers of ... subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications», а «Developers building products ... including those using the Agent SDK, should use API key authentication»; запрещено предлагать claude.ai login третьим лицам и «route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users». auto-dev для собственного аккаунта владельца под это не подпадает буквально, но это не «ordinary use». Риск нужно принять осознанно. Для headless VM есть `claude setup-token` -> `CLAUDE_CODE_OAUTH_TOKEN` (годовой токен, только model requests, не читается в `--bare`). Источники: [support 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), [authentication](https://code.claude.com/docs/en/authentication).
3. **Remote Control не подходит как «наш» UI, но подходит как дополнительный канал.** Он показывает сессию только в claude.ai/code и мобильном приложении (встроить нельзя), транскрипт хранится на серверах Anthropic, но зато: доступен на Pro/Max, только исходящие HTTPS, server mode `claude remote-control --spawn worktree --capacity N` держит до 32 сессий на процесс, каждая в своём worktree. Процесс должен жить (на VM запускать в tmux). Источник: [remote-control](https://code.claude.com/docs/en/remote-control).
4. **Нативные background sessions (`claude --bg`, agent view) закрывают «показать статус», но не «отправить сообщение скриптом».** `claude agents --json --all` отдаёт `state` (`working | blocked | done | failed | stopped`), `status` (`busy | waiting | idle`), `waitingFor` (`permission prompt | input needed | ...`). Но единственные способы отправить реплику в работающую фоновую сессию: TUI agent view (peek and reply), `claude attach` (нужен терминал) и `claude --resume <id> "prompt"`, который при перенаправленном stdin/stdout «sends nothing and exits with status 1». То есть без PTY (tmux) программно отправить нельзя. Research preview, формат `~/.claude/jobs/` «not a stable interface». Источник: [agent-view](https://code.claude.com/docs/en/agent-view), [sessions](https://code.claude.com/docs/en/sessions#resume-a-running-background-session).
5. **tmux + web terminal (ttyd / xterm.js+node-pty) стоит оставить как escape hatch.** Полная fidelity интерактивного TUI, `tmux send-keys -l` и `capture-pane -p -e` работают всегда, но это скрейпинг экрана: нет структурированных событий, permission prompt надо распознавать по тексту, два источника правды (экран и JSONL). Для «показать что делает агент» в красивом виде это хуже SDK-событий, для «дать человеку полноценный терминал к зависшему агенту» это лучший вариант.
6. **JSONL-транскрипты в `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` пишутся непрерывно и их можно tail-ить, но формат официально нестабилен:** «The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release». Hook-input предупреждает, что файл «written asynchronously and may lag the current turn». Подходит как read-only fallback и для истории, не как основной транспорт. Для SDK-сессий есть официальный real-time tap: `sessionStore.append()` вызывается «after each batch of transcript entries is written locally» плюс `listSessions()` / `getSessionMessages()`. Источники: [sessions#where-transcripts-are-stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored), [hooks](https://code.claude.com/docs/en/hooks), [session-storage](https://code.claude.com/docs/en/agent-sdk/session-storage).
7. **Готовые UI переиспользовать как библиотеку нельзя (ни один не выделяет серверную часть в пакет), но как референс архитектуры полезны:** claudecodeui/CloudCLI (AGPL-3.0, живой, на Agent SDK, есть встроенный xterm-терминал), Happy (MIT, живой, Agent SDK + relay-сервер с E2E, self-host сервера), Vibe Kanban (Apache-2.0, компания закрылась в апреле 2026, «community maintained», запускает CLI с `--input-format=stream-json` и реализует control-протокол сам на Rust). Лицензия AGPL у claudecodeui/opcode/claude-squad исключает копирование кода в закрытый продукт без открытия исходников.

Рекомендация: ядро на Agent SDK TS (streaming input, `canUseTool`, `includePartialMessages`), события и очередь входящих сообщений пробрасывать в UI по WebSocket; параллельно хранить `session_id` и путь JSONL для истории и восстановления после рестарта (`resume`); tmux+ttyd как опциональный «raw terminal» режим для ручного вмешательства; Remote Control как опциональный мобильный канал (включается `remoteControlAtStartup`, но для SDK-сессий это не подтверждено документацией).

## Сравнительная таблица

| Подход | Live view | Отправить сообщение в живую сессию | Параллельные сессии | Работает под Max | Поддержка/статус | Примечания |
| - | - | - | - | - | - | - |
| Agent SDK TS, streaming input | Да: `SDKMessage` поток, `stream_event` токены, `tool_progress`, `task_*`, `session_state_changed` (с env `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`) | Да: `streamInput()`/генератор, `priority: now/next/later`, `interrupt()`; permission и `AskUserQuestion` через `canUseTool` | Да: один `query()` = один процесс `claude`, ограничений нет кроме rate limits | Технически да (OAuth из `/login` или `CLAUDE_CODE_OAUTH_TOKEN`); юридически «серая зона», см. вывод 2 | Официальный, активные релизы (0.3.318 от 2026-11-04) | SDK-сессии не видны в `claude --resume` picker и `--continue`, но резюмируются по id. Терминала у них нет |
| `claude -p --input-format stream-json --output-format stream-json` напрямую | Да: тот же NDJSON, что в SDK | Да: несколько `{"type":"user",...}` строк в stdin в одном процессе; permission через `control_request`/`control_response` (протокол формально не документирован, видно из SDK и Vibe Kanban) | Да | Как у SDK | Официальный CLI; протокол control_request без публичной спецификации | Полезно только если не хочется Node-зависимости; иначе SDK проще |
| Background sessions / agent view (`claude --bg`, supervisor daemon) | Частично: `claude agents --json` даёт state/status/waitingFor, `claude logs <id>` хвост вывода; полноценный live только через `claude attach` в терминале | Только интерактивно: peek-reply в TUI, `claude attach`, `claude --resume <id> "prompt"` из терминала. С перенаправленным stdin/stdout: «sends nothing and exits with status 1» | Да, каждая в своём worktree `.claude/worktrees/` | Да, «uses your subscription quota independently» | Research preview, API меняется от версии к версии | Простаивающий процесс гасится через ~1 час (пин `Ctrl+T`); credentials берёт из supervisor |
| Remote Control (`claude remote-control`, `--remote-control`, `/rc`) | Да, но только в claude.ai/code и мобильном приложении; не встраивается | Да, из claude.ai/app, включая ответы на permission и `AskUserQuestion`, вложения, смену модели | Да: server mode `--capacity` (по умолчанию 32), `--spawn worktree`; вне server mode одна удалённая сессия на процесс | Да: Pro, Max, Ultra, Team, Enterprise; API-ключи не поддерживаются | Официальный, активно развивается | Только исходящие HTTPS; транскрипт хранится у Anthropic; процесс должен жить (tmux); не работает с `ANTHROPIC_BASE_URL`, Bedrock/Vertex, `DISABLE_TELEMETRY` |
| Cloud sessions claude.ai/code + self-hosted environments | Да, в claude.ai | Да, в claude.ai и `claude -p "msg" --cloud <id>` | Да | Cloud sessions на Max да, но **self-hosted runners только Team/Enterprise (public beta)** | Официальный | Для своей VM под Max недоступно; `--cloud` клонирует с GitHub, не вашу VM |
| tmux + web terminal (ttyd, gotty, wetty, xterm.js+node-pty) | Да, пиксельно точный TUI; программно `tmux capture-pane -p -e`, `pipe-pane`, control mode `%output` | Да: `tmux send-keys -l -t <pane> "text" Enter`; человек печатает в браузере | Да, одна tmux-сессия/окно на агента | Да (обычный интерактивный `claude`) | tmux 3.8 (2026-09), ttyd 1.7.7 (релиз 2024-03, коммиты 2026-08), gotty fork sorenisanerd v1.10.0 (2026-10), wetty v4.2.1 (2026-10), xterm.js 6.0.0, node-pty 1.1.0 | Скрейпинг экрана, нет структурированных событий; безопасность: ttyd/gotty readonly по умолчанию, basic auth, нужен TLS/reverse proxy |
| Tail JSONL `~/.claude/projects/...` | Да, с задержкой; все типы записей (user, assistant с tool_use, system, служебные) | Нет (read-only) | Да, по файлу на сессию | Да | Официально задокументировано расположение; **формат нестабилен** | Хорош для истории/аудита и восстановления, плох как единственный источник live-статуса |
| Готовые UI (claudecodeui, Happy, Vibe Kanban, opcode, claude-squad, CCUI) | Да у всех | Да у claudecodeui/Happy/Vibe Kanban (follow-up через SDK/`--resume`), claude-squad/CCUI через PTY | Да у всех | Да: все используют локальный `claude` login | См. детали ниже; opcode без релизов, sugyan/claude-code-webui и wbopan/cui архивированы, Vibe Kanban компания закрыта | Не библиотеки; лицензии AGPL (claudecodeui, opcode, claude-squad) vs MIT (Happy, sugyan, CCUI) vs Apache-2.0 (Vibe Kanban, cui) |

## 1. Remote Control и claude.ai/code

### Что это

«Remote Control connects claude.ai/code or the Claude app ... to a Claude Code session running on your machine». «Claude keeps running locally the entire time». Можно работать с обеих сторон одновременно: «the conversation ... stay in sync across all connected devices». Источник: https://code.claude.com/docs/en/remote-control

### Требования

- Подписка: «available on Pro, Max, Ultra, Team, and Enterprise plans. API keys are not supported». На Team/Enterprise нужен admin-toggle.
- Аутентификация: `/login` через claude.ai. `CLAUDE_CODE_OAUTH_TOKEN` от `claude setup-token` **не подходит**: «It can only make model requests, so it can't establish Remote Control sessions» (https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).
- Не работает с Bedrock/Vertex/Foundry, с `ANTHROPIC_BASE_URL` не на `api.anthropic.com`, с `DISABLE_TELEMETRY` / `DO_NOT_TRACK`.
- Workspace trust: `claude remote-control` в недоверенной директории спрашивает `Trust <directory>? [y/N]`; «When its standard input or output isn't a terminal, the command can't ask and exits with a Workspace not trusted error». То есть на VM сначала один раз запустить интерактивно.

### Три режима запуска

- `claude remote-control` (server mode): «Runs in server mode (no local interactive session)». Флаги: `--name`, `--spawn same-dir|worktree|session`, `--capacity <N>` («Maximum number of concurrent sessions. Default is 32»), `--permission-mode`, `--continue`, `--session-id`. В `worktree` режиме «each on-demand session gets its own git worktree». Новые сессии создаются из claude.ai/app.
- `claude --remote-control` (`--rc`): обычная интерактивная сессия плюс удалённый доступ. «outside of server mode, each Claude Code instance supports one remote session at a time».
- `/remote-control` внутри сессии: подхватывает текущую историю.
- Автовключение: `remoteControlAtStartup: true` в `~/.claude/settings.json`; «each interactive Claude Code process registers one remote session».

### Headless VM и много сессий

- «Remote Control runs as a local process. If you close the terminal ... the session goes offline». «If you run `claude` from a terminal on a remote machine, start it inside `tmux` or `screen`».
- Сеть: «makes outbound HTTPS requests only and never opens inbound ports»; «registers with the Anthropic API and polls for work». Server mode при недоступности сети «gives up after roughly 10 minutes and the `claude remote-control` process exits».
- Данные: «While Remote Control is connected, the session transcript ... is stored on Anthropic servers».
- После остановки сервера сессии можно вернуть `claude remote-control` / `--continue` / `--session-id` «for about four hours».
- Permission prompts и `AskUserQuestion` «keeps ... open until you answer them»; прочие диалоги закрываются через 5 минут (`dialogExpiry`).
- Из web/mobile работают `/compact`, `/clear`, `/context`, `/model <name>`, `/effort`, `/rename` и др.; `/resume`, `/plugin` только локально.
- Упавшую сессию в server mode «send it a message from a connected device. Claude Code serves it again» (v2.1.238+).

### claude.ai/code (cloud sessions) и своя машина

Cloud session «runs on cloud infrastructure instead of on your machine. By default it runs on infrastructure Anthropic manages, or on your organization's self-hosted environment when routed there». Self-hosted environments: «public beta on Team and Enterprise plans». Для Pro/Max документация прямо отсылает к Remote Control: «To run Claude Code on your own always-on machine and drive it from other devices, use Remote Control, which is also available on Pro, Max, and Ultra plans». Источники: https://code.claude.com/docs/en/claude-code-on-the-web , https://code.claude.com/docs/en/self-hosted-environments

Вывод: под Max подключить собственную VM к claude.ai/code можно только через Remote Control, не через cloud sessions.

## 2. Claude Agent SDK (TypeScript)

Пакет `@anthropic-ai/claude-agent-sdk` 0.3.318, лицензия «SEE LICENSE IN README.md» (LICENSE.md: «© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance»). Бинарь Claude Code поставляется как optionalDependencies по платформам (`@anthropic-ai/claude-agent-sdk-linux-x64` и т.д.), либо `pathToClaudeCodeExecutable`. Peer deps: `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod@^4`. Источник: npm tarball, проверено локально.

### Streaming input (отправка follow-up в работающую сессию)

«Streaming input mode is the preferred way ... It allows the agent to operate as a long lived process that takes in user input, handles interruptions, surfaces permission requests, and handles session management». Возможности: «Queued messages: send multiple messages that process sequentially, with ability to interrupt». `prompt` принимает `AsyncIterable<SDKUserMessage>`. Источник: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode

`Query` интерфейс: `interrupt()`, `setPermissionMode()`, `setModel()`, `streamInput(stream: AsyncIterable<SDKUserMessage>)`, `close()`. Все «only available in streaming input mode». Источник: https://code.claude.com/docs/en/agent-sdk/typescript

`SDKUserMessage` (из reference): `{ type: "user", message: MessageParam, parent_tool_use_id: string | null, priority?: "now" | "next" | "later", shouldQuery?: boolean, client_composed?: true, origin?, ... }`. «`priority` controls delivery during a running turn. `"next"` (or unset) is read in the same turn after the current tool calls finish. `"later"` waits for the turn to end. `"now"` interrupts the turn». `shouldQuery: false` «appends the message to the transcript without starting a turn».

Single message mode (`query({ prompt: "string" })`) «does not support ... Dynamic message queueing, Real-time interruption, Natural multi-turn conversations».

### Выходные события

`SDKMessage` union (полный список в reference): `SDKAssistantMessage`, `SDKUserMessage`, `SDKUserMessageReplay`, `SDKResultMessage`, `SDKSystemMessage` (init), `SDKPartialAssistantMessage` (`type: "stream_event"`, при `includePartialMessages: true`), `SDKCompactBoundaryMessage`, `SDKStatusMessage`, hook-события, `SDKToolProgressMessage`, `SDKTaskStartedMessage`/`Progress`/`Updated`/`Notification`, `SDKBackgroundTasksChangedMessage`, `SDKThinkingTokensMessage`, `SDKSessionStateChangedMessage` (`state: "idle" | "running" | "requires_action"`, требует `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`), `SDKPermissionDeniedMessage`, `SDKRateLimitEvent`, `SDKConversationResetMessage` и др. Порядок при streaming: `message_start` -> `content_block_start` -> `content_block_delta`... -> `AssistantMessage` на каждый завершённый блок -> ... -> `result`. Источники: https://code.claude.com/docs/en/agent-sdk/typescript , https://code.claude.com/docs/en/agent-sdk/streaming-output

Subagents: сообщения сабагентов приходят как `user`/`assistant` с `parent_tool_use_id`; текст и thinking сабагентов только с `--forward-subagent-text` / `forwardSubagentText`. Источник: https://code.claude.com/docs/en/headless#follow-subagent-messages

### `canUseTool` и ожидание человека

«Claude requests user input in two situations: when it needs permission to use a tool ..., and when it has clarifying questions (via the `AskUserQuestion` tool). Both trigger your `canUseTool` callback, which pauses execution until you return a response». «The callback can stay pending indefinitely». Для долгого ожидания с выходом процесса: `PreToolUse` hook с решением `defer` («ends the turn so the tool can be resumed later, and requires non-interactive mode with the `-p` flag»; результат `stop_reason: "tool_deferred"` + `deferred_tool_use`; затем `claude -p --resume <session-id>`). Ответ на `AskUserQuestion`: `{ behavior: "allow", updatedInput: { questions, answers: { "<question>": "<label>" } } }`, есть `response` для свободного текста. Ограничение: «`AskUserQuestion` is not currently available in subagents». Источники: https://code.claude.com/docs/en/agent-sdk/user-input , https://code.claude.com/docs/en/hooks

Важно: `canUseTool` «never fires for auto-approved tools» (allow-правила, `acceptEdits`, `bypassPermissions`). `--permission-prompts none` отключает ожидание хоста и убирает `AskUserQuestion` из набора инструментов.

Hooks в SDK: `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>`; события включают `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification` (типы `permission_prompt`, `idle_prompt`, `agent_needs_input`, ...), `Stop`, `SessionStart` и др. Источник: https://code.claude.com/docs/en/agent-sdk/typescript , https://code.claude.com/docs/en/hooks

### Resume / fork / видимость

- `resume: sessionId`, `forkSession: true`, `continue: true`, `persistSession: false`, `resumeSessionAt`. Session id берётся из `system/init` или `result`.
- «Claude Code leaves sessions created with `claude -p` or the Agent SDK out of the session picker and out of `claude --continue`. You can still resume one by passing its session ID to `claude --resume <session-id>`». Источник: https://code.claude.com/docs/en/sessions#loop-p-agent-sdk-and-background-sessions
- Для интерактивного вмешательства в SDK-сессию «из терминала» документированного пути нет; можно `claude --resume <id>` (создаст второй процесс на тот же транскрипт: «If you resume the same session in two terminals without forking, messages from both interleave into one transcript»). Не рекомендуется одновременно.
- `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()` для построения своего session picker. `sessionStore` для зеркалирования транскрипта в свою БД в реальном времени (`append` «After each batch of transcript entries is written locally»). Источник: https://code.claude.com/docs/en/agent-sdk/session-storage
- Experimental V2 API (`createSession`/`send`/`stream`) удалён в 0.3.142; использовать `query()`.

### Аутентификация под Max

- SDK читает те же credentials, что и CLI (`~/.claude/.credentials.json` на Linux, порядок приоритетов: `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > OAuth из `/login`). `--bare` не читает OAuth. Источник: https://code.claude.com/docs/en/authentication
- Обзор SDK: «Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK». Источник: https://code.claude.com/docs/en/agent-sdk/overview
- Legal: «Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK» и цитаты из вывода 2. Источник: https://code.claude.com/docs/en/legal-and-compliance
- Support (обновления 15.06.2026 и 07.10.2026): SDK и `claude -p` «still draw from your subscription limits»; «Claude Max, Ultra, and Team plans now include monthly API credits», но они применяются к SDK «only when you run them with an API key from your linked Claude Console organization». Источник: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

## 3. `claude -p --input-format stream-json --output-format stream-json`

- `--input-format`: «"text" (default), or "stream-json" (realtime streaming input)» (`claude --help`, 2.1.318). `--replay-user-messages`: «Re-emit user messages from stdin back on stdout for acknowledgment». `--include-partial-messages`, `--verbose` обязательны для stream-json вывода.
- Несколько ходов в одном процессе подтверждается документацией косвенно: «With `--input-format stream-json`, a message still queued when the limit ends a turn stays queued and starts a new turn with its own limit» (CLI reference, `--max-turns`), и напрямую тем, что SDK запускает ровно `"--input-format","stream-json"` + `"--output-format","stream-json"` и шлёт туда `SDKUserMessage` по одной строке (проверено в `sdk.mjs`). Источники: https://code.claude.com/docs/en/cli-reference , npm `@anthropic-ai/claude-agent-sdk@0.3.318`
- Схема входной строки = `SDKUserMessage`: `{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}` (content может быть массивом блоков с `image`). Выход = `SDKMessage` NDJSON, последняя строка хода `{"type":"result",...}` с `session_id`, `total_cost_usd`, `permission_denials`.
- Permission prompts без SDK: либо `--permission-prompt-tool mcp__<server>__<tool>` (MCP-инструмент, которому CLI отдаёт запрос), либо `--permission-prompts none` (всё, что просило бы разрешение, отклоняется). Источник: https://code.claude.com/docs/en/headless
- Control-протокол (`control_request` / `control_response` с subtypes `initialize`, `interrupt`, `set_permission_mode`, `set_model`, `can_use_tool`, `hook_callback`, `mcp_message`, `elicitation`, ...) формальной публичной спецификации не имеет; известен из бандла SDK и из реализации Vibe Kanban (`crates/executors/src/executors/claude/protocol.rs`). Статус: **не подтверждено как стабильный публичный контракт**. Reference лишь упоминает: «The `control_request` envelope's `request_id`. A `control_response` your application sends outside the SDK ... must echo this value».
- SIGTERM: выход с кодом 143, ход не завершён; для корректного завершения хода SIGINT или `interrupt()`. Источник: https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm

## 4. tmux + web terminal

### tmux (ISC, 3.8 от 2026-09-09, активен)

Из man-страницы https://man.openbsd.org/tmux :

- `send-keys [-l] [-t target-pane] key ...`: «The `-l` flag disables key name lookup and processes the keys as literal UTF-8 characters». Практика: `tmux send-keys -t agent1 -l "текст"` затем `tmux send-keys -t agent1 Enter`.
- `capture-pane -p -e -S - -E -`: «If `-p` is given, the output goes to stdout»; `-e` «includes escape sequences for text and background attributes»; `-S`/`-E` задают диапазон строк включая scrollback; `-J` склеивает перенесённые строки.
- `pipe-pane`: «Pipe output sent by the program in target-pane to a shell command or vice versa» (непрерывный поток вывода пейна).
- Control mode (`tmux -C`/`-CC`): «a client sends tmux commands ... on standard input», ответы в блоках `%begin`/`%end`/`%error`, нотификации `%output pane-id value` («value escapes non-printable characters and backslash as octal \xxx»), `%exit`. Это структурированный способ читать вывод без polling.
- `new-session -d -s <name>` создаёт отсоединённую сессию; `-S socket-path` для отдельного сокет-файла (изоляция от пользовательских tmux).

### Web-терминалы

| Инструмент | Что это | Auth / security | Статус |
| - | - | - | - |
| ttyd (tsl0922/ttyd, MIT, 12.6k stars) | «simple command-line tool for sharing terminal over the web», libuv + xterm.js | «readonly by default», `-W` для записи, `-c user:pass` basic auth, `-S/--ssl`, `-O` запрет cross-origin, `-b base-path` за reverse proxy, `-m max-clients`, `-i` UNIX socket | Последний релиз 1.7.7 (2024-03-30), коммиты в репо 2026-08-12. README: https://github.com/tsl0922/ttyd |
| gotty (sorenisanerd/gotty, MIT) | Go, «turns your CLI tools into web applications»; оригинал yudai/gotty не обновлялся с 2024-08 | `-w` «Permit clients to write to the TTY (BE CAREFUL)», `-c` basic auth, `-t` TLS, `-r` random URL, `--ws-origin` | Форк sorenisanerd активен: v1.10.0 (2026-10-10). README: https://github.com/sorenisanerd/gotty |
| wetty (butlerx/wetty, MIT) | «Terminal over HTTP and https», xterm.js + Socket.IO, подключается через ssh к localhost или удалённому хосту | SSH-аутентификация (`--ssh-auth`, `--ssh-key`), обязательный `--allowed-origin`, рекомендует reverse proxy | v4.2.1 (2026-10-25). README: https://github.com/butlerx/wetty |
| xterm.js (MIT, 6.0.0 от 2025-12-22) + node-pty (microsoft, MIT-текст, 1.1.0 от 2025-12-22) | Собственный web-терминал: node-pty форкает PTY с `tmux attach -t agentN`, xterm.js рендерит в браузере по WebSocket | Полностью ваша auth-модель (та же, что у web UI auto-dev) | Оба активны (коммиты 2026-10/11). https://github.com/xtermjs/xterm.js , https://github.com/microsoft/node-pty |

Выводы по tmux-подходу: `tmux send-keys` отправляет текст в любую интерактивную сессию (в том числе в `claude attach <id>` и в Remote Control server). Чтение экрана через `capture-pane`/control mode даёт только рендер TUI, а не события; «агент ждёт человека» придётся определять эвристикой по тексту либо параллельно по `claude agents --json` / JSONL / hooks (`Notification` с `notification_type: permission_prompt | idle_prompt`). Безопасность: ни один из web-терминалов не стоит выставлять без TLS и своей аутентификации; ttyd/gotty по умолчанию readonly, запись включать явно.

## 5. Существующие UI поверх Claude Code

Метаданные из GitHub API на 2026-11-04 (лицензия, последний push, звёзды, релиз).

| Проект | Что делает | Как говорит с Claude | Параллельные сессии | Сообщение в живую сессию | Worktrees | Лицензия | Последний коммит / релиз | Библиотека? | Подписка |
| - | - | - | - | - | - | - | - | - | - |
| siteboon/claudecodeui (CloudCLI, 14.4k) | Web + mobile UI для Claude Code, Codex, Cursor, OpenCode; file/git explorer, встроенный shell на xterm.js; плагины-вкладки | Agent SDK (`@anthropic-ai/claude-agent-sdk ^0.3.165`, `query()` с `resume`, `resumeSessionAt`, `permissionMode`, обработка `AskUserQuestion`/`ExitPlanMode` как интерактивных) в `server/modules/providers/list/claude/claude-runtime.provider.ts` | Да | Да (новый run на тот же session id, предыдущий query прерывается; см. комментарий «Query instances interrupted because a newer run took over») | Не упоминается | AGPL-3.0-or-later | push 2026-11-04, v1.37.7 (2026-10-31) | Нет, монолит (Express + SQLite + React); npm `@cloudcli-ai/cloudcli` | «All options use your own AI subscriptions» |
| slopus/happy (24.5k) | Мобильное/web приложение + CLI-обёртка `happy claude`, relay-сервер, E2E-шифрование, daemon для запуска сессий с телефона | `happy` (packages/happy-cli) зависит от `@anthropic-ai/claude-agent-sdk ^0.3.295` | Да, daemon «spawn and manage coding sessions remotely» | Да, с телефона/web («either of you can steer it») | Не упоминается | MIT | push 2026-11-04, cli-1.2.5 (2026-09-22) | Нет, но сервер self-hostable (`HAPPY_SERVER_URL`, пакет `happy-server-self-host`) | «Sign in with the Claude, Codex, and Grok subscriptions you already pay for» |
| BloopAI/vibe-kanban (28.6k) | Kanban + workspaces: issue -> workspace с веткой, терминалом, dev server; diff review с комментариями, PR | Запускает CLI `npx -y @anthropic-ai/claude-code@2.1.119` с `--output-format=stream-json --input-format=stream-json`, свой Rust-клиент control-протокола (`can_use_tool` через hook callbacks); follow-up через `--resume <id>` (`spawn_follow_up`) | Да | Да, follow-up в attempt; inline-комментарии к diff отправляются агенту | Да, каждая workspace в своей ветке/worktree | Apache-2.0 | push 2026-11-04, релиз v0.1.44 (2026-04-24). **«Vibe Kanban is sunsetting»**: пост от 2026-04-10, remote-сервисы отключены через 30 дней, «The Vibe Kanban project will live on, open source and community maintained» | Нет; есть MCP server и REST backend без публичного контракта | «Make sure you have authenticated with your favourite coding agent» (локальный login) |
| winfunc/opcode (бывш. getAsterisk/claudia, 22.4k) | Desktop GUI (Tauri 2, Rust + React): сессии, resume, checkpoints, «background agents» в отдельных процессах | Требует `claude` в PATH; детали не документированы | Частично (отдельные процессы) | Не подтверждено | Не упоминается | AGPL-3.0 | push 2026-09-18, релиз v0.2.0 (2025-08-31); README: «Release Executables Will Be Published Soon» | Нет, desktop-only | Локальный login |
| sugyan/claude-code-webui (1.1k) | Web-чат поверх `claude` CLI: streaming, permission mode, история сессий | «executes Claude CLI locally» (`--claude-path`) | Не заявлено | Не заявлено | Нет | MIT | **archived**, push 2026-05-29; README: «This project is no longer actively maintained» | Нет | Локальный login |
| smtg-ai/claude-squad (8.7k) | TUI для управления несколькими агентами: tmux-сессия + git worktree на задачу, `-y` auto-yes (experimental) | tmux + интерактивный `claude` | Да | Только через attach к tmux (`↵/o`) | Да | AGPL-3.0 | push 2026-08-20 | Нет, Go-бинарь `cs` | Локальный login |
| yxwucq/CCUI (32) | «Web dashboard for Claude Code and OpenAI Codex CLI that enables multi-worktree parallel development», каждая сессия в xterm.js с PTY, статус running/waiting/idle | CLI в PTY | Да | Через терминал | Да, fork/attach ветки | MIT (в README; поле license в API пустое) | push 2026-04-10 | Нет | Локальный login |
| wbopan/cui (1.1k) | Web UI для Claude Code с параллельными фоновыми агентами | не проверено | Да | не проверено | не проверено | Apache-2.0 | **archived**, push 2026-03-20 | Нет | не проверено |
| «CCW», «Claude Code Web UI» | Репозиторий с названием CCW не найден (поиск по GitHub/веб); «Claude Code Web UI» совпадает с sugyan/claude-code-webui | не подтверждено | | | | | | | |
| omnara-ai/omnara (3.4k) | Раньше позиционировался как mobile-control для Claude Code; сейчас «open-source managed agent platform. A self-hostable alternative to Claude Managed Agents» на любых моделях через свой API | Свой harness, не Claude Code | | | | Apache-2.0 | push 2026-11-04 | SDK `@omnara/sdk`, но это другая задача | API-ключи провайдеров |
| The-Vibe-Company/companion (2.4k) | Пивот: «Persistent AI companions ... powered by Pi» (не Claude Code UI); старый «Claude Code / Codex Web UI» остался только в форках (ding1dingx/companion, push 2026-02) | Pi harness | | | | MIT | push 2026-10-12 | Нет | |

Общий вывод по разделу: все живые проекты, которым нужны структурированные события и follow-up в сессию, сходятся на Agent SDK (claudecodeui, Happy) или на прямом `stream-json` протоколе (Vibe Kanban). Проекты на tmux/PTY (claude-squad, CCUI) дают терминал, но не события. Ни один не оформлен как переиспользуемая библиотека; самый близкий к «готовому серверу» вариант с подходящей лицензией (MIT) и self-host: Happy (relay + CLI + мобильное приложение), но его UI это чужое приложение, а не ваш web.

## 6. Нативные файлы сессий (JSONL)

### Расположение

«Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path with non-alphanumeric characters replaced by `-`». Имя длиннее 200 символов обрезается и дополняется хэшем. `CLAUDE_CONFIG_DIR` переносит хранилище; `CLAUDE_CODE_PROJECT_DIR_NAME` (вместе с `CLAUDE_CONFIG_DIR`) задаёт имя каталога проекта вручную (удобно для «host that embeds Claude Code and gives each session its own config directory», v2.1.234+). Сабагенты: `subagents/agent-<id>` рядом. Источники: https://code.claude.com/docs/en/sessions#where-transcripts-are-stored , https://code.claude.com/docs/en/agent-sdk/session-storage

Локальная проверка на этой машине (2.1.318): файл `~/.claude/projects/-Users-lembdev-Developer-lembdev-auto-dev/<uuid>.jsonl`, каталог совпадает с правилом замены символов.

### Инкрементальность

«Sessions are saved continuously to local transcript files as you work». Но в описании hook-поля `transcript_path`: файл «written asynchronously and may lag the current turn»; для Stop hook рекомендуют `last_assistant_message` вместо чтения транскрипта. Итого: tail работает, но с задержкой и без гарантии, что последняя строка уже записана. Источники: https://code.claude.com/docs/en/sessions , https://code.claude.com/docs/en/hooks

### Содержимое

Документация: «Each line is a JSON object: a message, a tool use or result, a record of a request Claude Code sent the model, or a metadata entry».

Наблюдение в локальном файле (333 строки, 2.1.318), поле `type`: `user` (31; в `message.content` либо текст, либо массив с `tool_result`), `assistant` (57; `message.content` с блоками `thinking`, `text`, `tool_use`, по одному блоку на строку, общий `message.id`), `system` (subtypes `turn_duration`, `stop_hook_summary`, `away_summary`), а также служебные `mode`, `permission-mode`, `session-owner`, `api-request`, `api-request-blob`, `api-request-shape`, `attachment`, `ai-title`, `last-prompt`, `tools-used`, `file-history-snapshot`, `bridge-session`, `atis-latch`. У сообщений есть `uuid`, `parentUuid`, `isSidechain`, `promptId`, `sessionId`, `timestamp`, `cwd`. Это наблюдение одной версии, не контракт.

### Стабильность

Прямо: «The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release. To build on session data, use `/export` or the script interfaces instead». Официальные альтернативы: `claude -p --output-format json|stream-json`, `claude -p --resume <id>`, `transcript_path` из hooks, Agent SDK (`getSessionMessages()` возвращает «post-compaction chain», `store.load()` сырые записи). Ретенция: `cleanupPeriodDays` (30 дней по умолчанию); `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` ограничивает рост файла для `-p`/SDK сессий. Источник: https://code.claude.com/docs/en/sessions#access-conversations-from-scripts

## Дополнительно: background sessions / agent view как альтернатива оркестратору

Полезно знать, потому что это нативный «менеджер параллельных агентов» с супервизором:

- Запуск: `claude --bg "prompt"`, `claude --bg --name <n>`, `claude --resume <id> --bg "..."`; «Claude Code rejects `--bg` combined with `-p`». В git-репозитории каждая сессия «moves into its own worktree under `.claude/worktrees/`».
- Супервизор: «a background service that runs your background sessions so they keep working after you close agent view or your terminal»; «Each session is its own Claude Code process under the supervisor». Состояние: `~/.claude/daemon/roster.json`, `~/.claude/jobs/<id>/state.json` (локально видно поля `state`, `detail`, `tempo`, `inFlight`, `respawnFlags`, `bridgeSessionId`), сокет `/tmp/cc-daemon-<uid>/...` (из `claude daemon status`). «not a stable interface».
- Скриптовый опрос: `claude agents --json --all` (поля `id`, `cwd`, `kind`, `state`, `pid`, `status`, `waitingFor`, `sessionId`, `name`). Проверено локально: вывод соответствует описанию.
- Отправка реплики: только peek-reply в TUI, `claude attach`, или `claude --resume <id> "prompt"` из интерактивного терминала; при перенаправленном вводе/выводе «Claude Code sends nothing and exits with status 1». Уведомления: `Notification` hook с `agent_needs_input` / `agent_completed` «Fires only while agent view is open in a terminal».
- Жизненный цикл: простаивающая неприкреплённая сессия останавливается через ~1 час (пин `Ctrl+T`), credentials берутся из супервизора, после перезагрузки машины сессии останавливаются. Research preview.

Источник: https://code.claude.com/docs/en/agent-view

Вывод: для auto-dev это конкурент собственному оркестратору, а не компонент; программного канала «отправить сообщение» у него нет, поэтому для требования (b) он не подходит без tmux-обвязки.

## Неподтверждённое / требует проверки экспериментом

- Стабильность control-протокола `control_request`/`control_response` при прямом использовании CLI без SDK: публичной спецификации нет.
- Можно ли включить Remote Control для SDK-сессии: в `sdk.d.ts` есть опции `remoteControlAtStartup` и `disableRemoteControl`, в документации SDK это не описано.
- Насколько быстро транскрипт JSONL догоняет текущий ход (задержка записи): документация говорит «may lag», цифр нет.
- Поведение `canUseTool`, если человек отвечает через часы: документация говорит «can stay pending indefinitely», но сетевой/процессный таймаут на практике не проверен; для долгих ожиданий рекомендован `defer` + `resume`.
- Юридическая допустимость использования подписки Max собственным оркестратором на Agent SDK: формулировки Anthropic (см. вывод 2) допускают разные трактовки; при необходимости уточнять у Anthropic sales/support.
