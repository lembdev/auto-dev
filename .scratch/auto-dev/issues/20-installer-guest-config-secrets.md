# Установщик: форма гостя, конфиг, секреты и первый запуск

Type: grilling
Status: resolved
Blocked by: 13

## Question

Какой гость создаёт установщик (LXC или VM, ОС, ресурсы), какой пользователь, что ставится. Где лежат секреты (GitHub token, OAuth-токен Claude), в каком виде, как Оркестратор собирает из них env Агента, как они меняются. Шаги мастера первого запуска и что он сохраняет.

## Answer

Решено 2026-11-05 (рекомендации агента, принятые пользователем заранее).

1. **Гость:** unprivileged LXC Debian 13 (research 04), default 4 vCPU / 8 GB RAM / 40 GB диск, параметры меняются в диалоге ct-скрипта. Пользователь `auto-dev` без sudo (кроме NOPASSWD на `/usr/bin/update`, тикет 13). Ставятся: git, gh, Node 22 LTS, `claude` native installer от `auto-dev`, приложение в `/opt/auto-dev`.
2. **Секреты:** один файл `/etc/auto-dev/env` (владелец `auto-dev`, права 0600), формат `KEY=value`: `AUTO_DEV_REPO` (owner/name), `GH_TOKEN` (fine-grained PAT: Issues write, Pull requests write, Contents write, Metadata read), `CLAUDE_CODE_OAUTH_TOKEN` (результат `claude setup-token` на машине человека, вставляется в мастер), `AUTO_DEV_PASSWORD_HASH` (argon2). `CLAUDE_CONFIG_DIR=/var/lib/auto-dev/claude` фиксирован. Оркестратор читает файл на старте и при сохранении настроек; env Агента собирается из него явно (05). `ANTHROPIC_API_KEY` в файле = отказ старта.
3. **Смена секретов:** страница «Настройки» в UI перезаписывает файл; новые процессы получают новый env сразу, живые гасятся как idle по концу Хода и поднимаются resume. Ротацию по расписанию не делаем; истечение OAuth-токена видно по `api_retry` с `authentication_failed`: Пауза + баннер «обновите токен».
4. **Мастер первого запуска** (UI на `:8080`, пока файла env нет): пароль -> репо и GitHub token -> проверка доступа (`gh api repos/<repo>`, права на issues и contents) -> OAuth-токен Claude -> smoke-query (как в 05) -> клон Продукта в `/var/lib/auto-dev/repo` -> готово. Каждый шаг сохраняется сразу, мастер можно продолжить после перезагрузки.
