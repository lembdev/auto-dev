# Research: обзор Codeman (Ark0N/Codeman): что переносимо в auto-dev

Type: research
Status: resolved

## Question

Пользователь увидел проект Codeman (self-hosted mission control для AI coding agents). Может ли он быть полезен auto-dev как основа, компонент или источник решений? Если что-то берём, какие открытые тикеты надо поправить.

## Answer

Как основа или компонент: нет. Codeman скрейпит терминал интерактивного Claude Code, не знает про GitHub issues/PR/labels и Стадии, respawn делает `/clear`, idle-чекер жжёт лимит отдельным Opus. Наш путь (Agent SDK streaming, тикет 05) подтверждается их же доками от противного.

Берём как референс, детали в [research/05-codeman-review.md](../research/05-codeman-review.md):

- A. Лимиты Max: форма `rate_limits` в statusline (проценты, `resets_at` в секундах, нет на первом рендере), лимит общий на аккаунт, пороги 60/85, инъекция statusline только через настройки процесса, auto-resume reset + 2 мин / ретрай 5 мин. Внесено в Notes тикета 12.
- B. Доставка Ответа ровно один раз: `clientId` + монотонный `seq`, pending до ACK, дедуп на сервере с watermark в ACK дубля, «отказано навсегда» как третий исход, дедуп в Рантайм-индексе. Внесено в Notes тикетов 07 и 09.
- C. Worktree: раскладка `<repo>/.claude/worktrees/<name>`, ветка `worktree-<name>` = нативный `claude --worktree`. Внесено в Notes тикета 08.
- D. UI: tile grid, окна сабагентов с линиями, QR-логин, away digest. Внесено в Notes тикетов 14 и 15.
