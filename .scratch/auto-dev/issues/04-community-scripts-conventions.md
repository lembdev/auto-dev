# Research: как устроены Proxmox VE Community Scripts (установка и обновление)

Type: research
Status: resolved

## Question

Как устроены скрипты community-scripts/ProxmoxVE, чтобы установщик auto-dev следовал их конвенциям?
- Структура: ct/*.sh и install/*-install.sh, функции build.func / install.func, переменные, whiptail-диалоги.
- Как они создают LXC/VM, как задаются ресурсы, как выбирается ОС.
- Механизм обновления: функция update_script, как пользователь запускает обновление уже развёрнутого контейнера, как версии приложения отслеживаются.
- Можно ли сделать свой скрипт вне их репозитория (self-hosted, curl | bash со своего GitHub) с теми же функциями, и как это принято делать.
- LXC vs VM для нашего случая (Node + git + Claude Code, без Docker): рекомендация.
Результат: .scratch/auto-dev/research/04-community-scripts-conventions.md с ссылками на github.com/community-scripts/ProxmoxVE и их docs.

## Answer

Полный отчёт: [research/04-community-scripts-conventions.md](../research/04-community-scripts-conventions.md) (с готовым скелетом ct/auto-dev.sh + install/auto-dev-install.sh).

- Движок вынесен в репозиторий community-scripts/core (build.func, install.func, tools.func и т.д.); в ProxmoxVE остались ct/*.sh и install/*-install.sh, метаданные на сайте.
- ct-скрипт: bootstrap core/build.func, APP + var_* (cpu/ram/disk/os/version/unprivileged), `update_script()`, затем start / build_container / description. Install-скрипт исполняется внутри контейнера через lxc-attach, функции передаются через env.
- Обновление: в контейнере генерируется `/usr/bin/update`, который тянет актуальный ct-скрипт и вызывает `update_script()`. Версия в `~/.<app>` (пишет `fetch_and_deploy_gh_release`), `check_for_gh_release` сравнивает с GitHub release. Массово с хоста: `pct exec ... update`.
- Self-hosting поддержан штатно: `COMMUNITY_SCRIPTS_URL` (наш репо) + `COMMUNITY_SCRIPTS_CORE_URL` (core, можно запинить на SHA), раннер core/tools/run.sh. Репо со скриптами должен быть публичным (raw без auth). Лицензии MIT. Побочки чужого движка: телеметрия (opt-out), запросы к их PocketBase, их брендинг.
- LXC vs VM: все их скрипты - unprivileged LXC, root внутри, nesting=1, keyctl=1. Для Node 22 + git + gh + Claude Code этого достаточно. VM только ради изоляции/миграции. Есть vm/*.sh, но без updater.
- Node: `setup_nodejs` с NODE_VERSION="22"; юниты systemd: Type=simple, User=root, WorkingDirectory=/opt/<app>, EnvironmentFile=/opt/<app>.env, Restart=on-failure. Для auto-dev нужен non-root user (Claude Code не стартует с bypass-permissions под root, см. тикет 01).
