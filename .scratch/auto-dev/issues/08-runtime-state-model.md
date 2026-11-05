# Модель рантайм-состояния на VM и восстановление после рестарта

Type: grilling
Status: open
Blocked by: 05

## Question

Что именно хранится локально (индекс: задача -> стадия -> session id -> процесс -> worktree -> PR -> круг QA), в каком формате (SQLite, JSON-файлы), как оркестратор при старте сверяет индекс с GitHub и живыми процессами, что делает с незавершёнными стадиями (продолжить сессию или начать заново). Транскрипт не хранится: UI читает родные файлы сессий Claude Code.

## Notes

- Из research 02: хранить session_id и путь к JSONL; для истории SDK-сессий есть `sessionStore` (listSessions, getSessionMessages).
- Из тикета 05: идентичность Агента = session id, процесс взаимозаменяем; рестарт оркестратора = `resume` всех живых Агентов с `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`; индекс должен хранить session id, idle-таймер и last-known-good `claude --version`.
- Из research 05 (Codeman): раскладка worktree `<repo>/.claude/worktrees/<name>`, ветка `worktree-<name>`, имена `[A-Za-z0-9._-]` до 64, совпадает с нативным `claude --worktree`; использовать её (или опцию worktree SDK), `.claude/worktrees` в git exclude. В Рантайм-индексе хранить также применённые `(clientId, seq)` и id комментариев GitHub для дедупа Ответов.
- Решение по 06 (2026-11-05): стадия Конвейера хранится только здесь, в GitHub меток auto-dev нет. Значит Рантайм-индекс обязан быть восстановимым и единственным источником стадии: при рестарте Оркестратора стадия читается из индекса, а не выводится из GitHub; сверка с GitHub только по assignee, `ready-for-agent`, состоянию issue и PR.
