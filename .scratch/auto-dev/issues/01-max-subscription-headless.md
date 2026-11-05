# Research: Claude Code Max на headless VM: auth, режимы запуска, лимиты

Type: research
Status: resolved

## Question

Что из способов запуска Claude Code легально и технически работает под подпиской Max (не API-ключ) на headless Linux VM без браузера?
- Как авторизоваться без браузера: claude login на headless, claude setup-token (долгоживущий OAuth token), перенос credentials-файла. Что из этого официально поддерживается.
- Работает ли под Max: claude -p (headless/print mode) с stream-json и --resume; Claude Agent SDK (TypeScript) через OAuth-токен подписки; кастомные tools/MCP в этих режимах.
- Политика Anthropic: допускает ли подписка Max автоматизированный/фоновый запуск агентов, несколько одновременных сессий, использование SDK. Цитировать условия.
- Лимиты: есть ли ограничение на число одновременных сессий; как устроены 5-часовые/недельные лимиты Max; что происходит при их исчерпании (ошибка, ожидание) и как это детектировать программно.
Результат: findings в .scratch/auto-dev/research/01-max-subscription-headless.md с ссылками на первоисточники (docs.anthropic.com / code.claude.com, GitHub anthropics/claude-code, support.anthropic.com).

## Answer

Полный отчёт: [research/01-max-subscription-headless.md](../research/01-max-subscription-headless.md).

- Официальный headless-путь под Max: `claude setup-token` на машине с браузером -> годовой OAuth token -> `CLAUDE_CODE_OAUTH_TOKEN` в окружении на VM. Альтернатива: `claude auth login` по SSH с вставкой кода. Перенос `.credentials.json` не задокументирован.
- Под подпиской работают: `claude -p` с `--output-format/--input-format stream-json`, `--resume`, `--session-id`, hooks, `--mcp-config`; Agent SDK (TS) с тем же токеном, in-process MCP и hooks. Не работают под OAuth-токеном: `--bare` (только API key; анонсировано, что `--bare` станет default для `-p` - риск), Remote Control, claude.ai connectors, `/schedule`.
- Политика: личная автоматизация на своём аккаунте допустима (docs: setup-token "for CI pipelines, scripts", лимиты "assume ordinary, individual usage of Claude Code and the Agent SDK"). Нельзя: продукт для третьих лиц на subscription login, шаринг токена, прокси.
- Лимиты: Max = 5x Pro на 5 часов и неделю, общие с claude.ai. Капа на concurrent sessions не найдено (не подтверждено). Исчерпание детектируется в stream-json: `rate_limit_event` (status rejected, resetsAt, utilization), result `is_error` + `api_error_status`; `-p` выходит non-zero. Остаток: только `rate_limits.five_hour/seven_day.used_percentage` в JSON statusline. `CLAUDE_CODE_RETRY_WATCHDOG=1` ждёт до resetsAt.
- Unattended: `--dangerously-skip-permissions` не стартует под root (нужен non-root systemd user) либо `--permission-mode auto --permission-prompts none`. Precedence: `ANTHROPIC_API_KEY` в `-p` тихо побеждает подписку - на VM его быть не должно.
