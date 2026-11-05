# Прототип: ask_human через PreToolUse defer и возврат Ответа при resume в Agent SDK

Type: prototype
Status: resolved
Blocked by: 05

## Question

Подтвердить на коде, что выбранная в тикете 05 механика работает под `CLAUDE_CODE_OAUTH_TOKEN`: in-process MCP tool ask_human, `PreToolUse` hook отвечает `defer`, ход завершается с `tool_deferred`, процесс завершён; затем `query({ resume: sessionId })` и Ответ человека попадает Агенту как результат того же вызова ask_human (каким именно образом результат подставляется: через повторный вызов tool при resume, через `deferred_tool_use`, или иначе). Проверить также: resume после SIGTERM посреди хода с `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, и что `disallowedTools: ["AskUserQuestion"]` убирает встроенный вопрос. Результат: короткий скрипт в `research/16-defer-resume/` и ответ «работает как есть / работает с оговорками / не работает, запасной вариант: tool возвращает «опубликовано», Ответ как новое user-сообщение».

## Notes

- Из research 02: `defer` «ends the turn so the tool can be resumed later, requires non-interactive mode with -p»; результат `stop_reason: "tool_deferred"` + `deferred_tool_use`.
- Из research 01: `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` «automatically resume if the previous session ended mid-turn. Used in SDK mode».

## Answer

Проверено 2026-11-05. Вердикт: **работает с оговорками**. Запасной вариант («tool возвращает "опубликовано", Ответ как новое user-сообщение») не нужен.

Две оговорки, обе обязательные:

1. **ask_human не может быть in-process SDK MCP tool (`createSdkMcpServer`).** При `resume` CLI проверяет доступность отложенного tool при загрузке сессии, раньше, чем SDK регистрирует in-process серверы через control-протокол. Результат всегда `stop_reason: "tool_deferred_unavailable"`, `is_error: true`, hook не вызывается. `alwaysLoad: true` не помогает. Работает **stdio MCP server** (отдельный процесс, `{ type: 'stdio', command, args }`): CLI поднимает его до проверки. Сам tool тривиальный (echo `answer` из input), вся логика остаётся в in-process `PreToolUse` hook оркестратора.
2. **Resume только в streaming input mode с открытым потоком и без промпта.** `prompt` = async-генератор, который ничего не yield-ит и не завершается, пока не придёт `result` (stdin CLI остаётся открыт, hook-и могут round-trip-ить). Если генератор завершается сразу (stdin закрыт), hook не вызывается, tool получает deny `"The user doesn't want to take this action right now..."`, модель переспрашивает и снова получает deny: вопрос потерян. Если передать строковый промпт (даже `''`), CLI сбрасывает отложенный вызов и запускает новый ход: модель переспрашивает новым `tool_use_id`, hook allow-ит, ответ доходит, но ценой лишнего вызова модели и мусорного `tool_deferred_unavailable`/deny в транскрипте.

### Последовательность событий (рабочий путь)

Ход 1, `query({ prompt: 'строка', options })`, `mcpServers: { human: stdio|sdk }`, `hooks.PreToolUse[matcher 'mcp__human__ask_human']`:

1. `system/init` (`session_id`, `tools` содержит `mcp__human__ask_human`, `mcp_servers: [{name: 'human', status: 'connected'}]`, `permissionMode: 'auto'`, `apiKeySource: 'none'`).
2. `assistant` с `tool_use` (`ToolSearch select:mcp__human__ask_human`, так как tool search включён по умолчанию), затем `assistant` с `tool_use {name: 'mcp__human__ask_human', input: {question, options}}`.
3. Hook `PreToolUse` получает `tool_name`, `tool_input`, `tool_use_id`; возвращает `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } }`.
4. `result`: `subtype: 'success'`, `stop_reason: 'tool_deferred'`, `terminal_reason: 'tool_deferred'`, `is_error: false`, `result: ''`, `deferred_tool_use: { id, name: 'mcp__human__ask_human', input: {question, options} }`, `session_id`. Процесс `claude` завершается сам, `query` итератор закрывается без исключения. Session id брать из `init` или `result`.

Ход 2 (после Ответа), `query({ prompt: openGenerator(), options: { ...те же, resume: sessionId } })`, hook на этот раз возвращает `{ permissionDecision: 'allow', updatedInput: { ...tool_input, answer } }`:

1. `command_lifecycle`.
2. Hook `PreToolUse` вызывается **с тем же `tool_use_id`** и тем же `tool_input`, что в ходе 1 (ещё до `system/init`).
3. Tool выполняется с `updatedInput`; stdio-сервер возвращает `"Human answered: blue"`.
4. `user` с `tool_result { tool_use_id: тот же id, content: [...] }`: Ответ попадает в сессию как результат того же вызова ask_human.
5. `system/init`, затем `assistant` (текст `blue`), `result` `stop_reason: 'end_turn'`, `terminal_reason: 'completed'`, `num_turns: 1`. Один вызов модели, лишних ходов нет. После `result` генератор промпта завершается, процесс выходит.

Итого: схема «defer -> resume -> повторный `PreToolUse` на том же вызове -> `allow` + `updatedInput` -> tool выполняется -> `tool_result`» соответствует документации hooks («Defer a tool call for later»). Никакого отдельного `deferred_tool_use`-ответа или control-запроса нет: Ответ человека кладётся в `updatedInput` (поле `answer` в схеме ask_human), tool сам возвращает его как текст результата.

Прочие факты:

- `disallowedTools: ['AskUserQuestion']` работает: с `canUseTool` без него `AskUserQuestion` есть в `init.tools`, с ним нет, `ToolSearch select:AskUserQuestion` отвечает «No matching deferred tools found», модель отвечает маркером «tool недоступен». Без `canUseTool` (нет permission host) `AskUserQuestion` не предлагается и так.
- SIGTERM посреди хода (child `claude` убит во время `Bash sleep 20`, exit code 143, `result` не пришёл) + `resume` с `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` в `env` и открытым потоком: `init`, затем `assistant` с `resume_reason: 'interrupted_turn'` и **новым** `tool_use_id` той же команды, tool выполнился, `result` `end_turn` с `resume_reason: 'interrupted_turn'`. Прерванный вызов перезапускается моделью заново (не in-place), ход доходит до конца. Без env-переменной не проверялось.
- Чтобы не тянуть user-level MCP серверы (context7, grafana, webstorm) в сессию Агента, нужен `strictMcpConfig: true`; иначе `init.mcp_servers` содержит их всех и старт тормозит.
- `env` SDK заменяет окружение целиком; с `{PATH, HOME}` CLI отвечает «Not logged in · Please run /login». Нужен полный `process.env` (минус `CLAUDE_CODE_*`/`ANTHROPIC_*` при запуске из-под Claude Code), stored login лежит в Keychain и читается без env.
- Правило доков «defer работает только при одном tool call в ходе» в прототипе не нарушалось; нужно учесть в промпте Стадии (ask_human не батчить с другими вызовами).
- Auth: проверка шла под **stored login** (`~/.claude`, подписка Max), не под `CLAUDE_CODE_OAUTH_TOKEN`/setup-token; `ANTHROPIC_API_KEY` не ставился; `init.apiKeySource: 'none'`. Механика от способа auth не зависит, но под setup-token отдельно не прогонялось.

Версии: `@anthropic-ai/claude-agent-sdk` 0.3.318, `claude` 2.1.318, node 26.7.0, модель `haiku` (`claude-haiku-5-5`). Скрипт: `research/16-defer-resume/run.mjs` (режимы `start`, `resume`, `tools-check`, `noq`, `sigterm`, `resume-interrupted`; env `PROTO_SERVER=stdio`, `PROTO_PROMPT_MODE=open|string|empty`), stdio-сервер `research/16-defer-resume/mcp-stdio.mjs`. Логи `research/16-defer-resume/out-*.jsonl`: рабочий путь это `out-start-...T17-27-39` + `out-resume-...T17-27-47` (stdio + open stream); `out-resume-...T17-20-54`, `T17-21-02`, `T17-25-54` это `tool_deferred_unavailable` с SDK-сервером; `T17-21-23` строковый промпт `''` (переспрос новым id); `T17-26-54` stdio + закрытый stdin (deny); `out-sigterm-...` + `out-resume-interrupted-...` SIGTERM-сценарий; `out-tools-check-...T17-25-36`/`T17-25-38` сравнение `init.tools` с/без `disallowedTools`.

Последствия для тикета 05, пункт 5: «in-process MCP tool» заменить на «stdio MCP tool (тонкий echo-процесс) + in-process `PreToolUse` hook»; в драйвер добавить правило «resume отложенного вызова только streaming input с открытым потоком, без промпта». Пункт 3 (resume после рестарта с `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`) подтверждён.
