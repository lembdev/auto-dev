# Прототип: ask_human через PreToolUse defer и возврат Ответа при resume в Agent SDK

Type: prototype
Status: open
Blocked by: 05

## Question

Подтвердить на коде, что выбранная в тикете 05 механика работает под `CLAUDE_CODE_OAUTH_TOKEN`: in-process MCP tool ask_human, `PreToolUse` hook отвечает `defer`, ход завершается с `tool_deferred`, процесс завершён; затем `query({ resume: sessionId })` и Ответ человека попадает Агенту как результат того же вызова ask_human (каким именно образом результат подставляется: через повторный вызов tool при resume, через `deferred_tool_use`, или иначе). Проверить также: resume после SIGTERM посреди хода с `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, и что `disallowedTools: ["AskUserQuestion"]` убирает встроенный вопрос. Результат: короткий скрипт в `research/16-defer-resume/` и ответ «работает как есть / работает с оговорками / не работает, запасной вариант: tool возвращает «опубликовано», Ответ как новое user-сообщение».

## Notes

- Из research 02: `defer` «ends the turn so the tool can be resumed later, requires non-interactive mode with -p»; результат `stop_reason: "tool_deferred"` + `deferred_tool_use`.
- Из research 01: `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` «automatically resume if the previous session ended mid-turn. Used in SDK mode».
