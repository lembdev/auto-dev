# Research: как показывать живого агента и говорить с ним из веб-UI

Type: research
Status: resolved

## Question

Какие существуют способы видеть работу запущенной сессии Claude Code в реальном времени и отправлять в неё сообщения, и что из них работает под подпиской Max?
- Claude Code Remote Control (/remote-control, управление сессией с claude.ai): что это, ограничения, подходит ли для VM.
- Agent SDK: streaming input (отправка сообщений в живую сессию), stream-json вывод, resume.
- tmux + web-терминал (ttyd, gotty, wetty): интерактивный Claude Code в tmux-окне, отдаваемом через браузер.
- Готовые UI поверх Claude Code: Vibe Kanban, claude-code-ui (siteboon), Happy, CCW и аналоги: что умеют, живые ли, лицензия, можно ли встроить или переиспользовать.
- Формат и расположение родных файлов сессий Claude Code (JSONL в ~/.claude/projects): можно ли тейлить их для отображения транскрипта.
Результат: сравнительная таблица в .scratch/auto-dev/research/02-live-agent-view-options.md с первоисточниками.

## Answer

Полный отчёт: [research/02-live-agent-view-options.md](../research/02-live-agent-view-options.md).

- Лучший вариант: Agent SDK (TS) в режиме streaming input: один долгоживущий процесс `claude` на Агента, поток `SDKMessage` (события tools, токены, состояние сессии), отправка follow-up сообщений в живую сессию, `interrupt()`, `canUseTool` для вопросов агента (callback может висеть сколько угодно, для долгих ожиданий есть `defer` + resume).
- `claude -p --input-format stream-json --output-format stream-json` использует тот же NDJSON-протокол, несколько user-turn на процесс работают; протокол control_request/response публично не описан (не подтверждено).
- Remote Control: работает под Max, но вид только в claude.ai/app (не встраивается), транскрипт хранится у Anthropic, не работает под setup-token, нужен интерактивный trust на VM. Только как опциональный мобильный канал.
- claude.ai/code на своей VM под Max недоступен (self-hosted только Team/Enterprise beta).
- Родные background sessions (`claude --bg`, `claude agents --json`) показывают статус, но не дают скриптово отправить сообщение в бегущую сессию.
- tmux + web-терминал (ttyd/gotty/wetty/xterm.js+node-pty живые): всегда работает, но это скрейпинг экрана без структурных событий. Оставить как запасной режим «сырой терминал».
- JSONL-транскрипты пишутся непрерывно, но с задержкой, формат объявлен внутренним и меняется между версиями. Для SDK-сессий есть официальный `sessionStore` (append, listSessions, getSessionMessages).
- Готовые UI (claudecodeui, Happy, Vibe Kanban, opcode, claude-squad): ни один не переиспользуется как библиотека; Vibe Kanban - компания закрыта, поддержка сообществом.
- Рекомендация: ядро на SDK + WebSocket в UI; хранить session_id и путь к JSONL для истории и resume; опционально tmux+ttyd как raw-режим.
