# Конвенции Proxmox VE Community Scripts: структура, создание LXC, обновление, self-hosting

Дата исследования: 2026-11-04. Все цитаты взяты из первичных источников, зафиксированных по commit SHA:

| Репозиторий | SHA main на момент исследования | Роль |
| --- | --- | --- |
| `community-scripts/core` | `7a1a54458c1da30b3e3c52596a7ae9a09702a3e9` | движок (engine): wizard, создание CT/VM, in-container bootstrap, helper-библиотека |
| `community-scripts/ProxmoxVE` | `06b788ee81175f42b0256d66725331b0c3d9643c` | канонические app-скрипты `ct/`, `install/`, `vm/`, `tools/pve/` |
| `community-scripts/DevScripts` | `ad794584d20af1e5779a34342ef0511707202034` | репозиторий для новых скриптов перед промоушеном в ProxmoxVE; там же `json/<app>.json` и `AGENTS.md` |

Сокращения ссылок ниже: `CORE` = `https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9`, `PVE` = `https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c`, `DEV` = `https://github.com/community-scripts/DevScripts/blob/ad794584d20af1e5779a34342ef0511707202034`.

Важное отличие от того, что предполагалось в вопросах: файлов `misc/build.func`, `misc/install.func`, `misc/core.func`, `misc/api.func`, `misc/tools.func`, `misc/create_lxc.sh` и `json/<app>.json` в `community-scripts/ProxmoxVE` больше нет. Движок вынесен в отдельный репозиторий `community-scripts/core` (создан 2026-08-05 по данным GitHub API), а метаданные приложений ведутся на сайте (PocketBase). Детали в разделе 1.

---

## Выводы для auto-dev

1. **Модель "две корневые точки" (two roots) делает self-hosting штатным сценарием.** Движок (`core/`, `ui/`, `lib/`, `lxc/`, `pve/`, ...) и скрипты (`ct/`, `install/`) резолвятся независимо: `COMMUNITY_SCRIPTS_CORE_URL` и `COMMUNITY_SCRIPTS_URL` это "plain base URL, so any host that serves raw files works" (DevScripts `docs/guides/source-origin.md`). Наш `ct/auto-dev.sh` может лежать в нашем GitHub, а движок браться из `community-scripts/core`. Единственное обязательное условие при запуске через `bash -c "$(curl ...)"`: передать `COMMUNITY_SCRIPTS_URL` явно, иначе движок будет искать `install/auto-dev-install.sh` в upstream ProxmoxVE и упадёт с exit 115 (`pve/backend.func`). Готовый способ: `core/tools/run.sh`, который выставляет обе базы и запускает скрипт.

2. **Лицензия не мешает.** Оба репозитория под MIT (ProxmoxVE: "Copyright (c) 2021-2026 tteck | community-scripts ORG"; core: "Copyright (c) 2026 Proxmox Helper Scripts (CE)"). Можно и sourcing по сети, и форк.

3. **Пин версии движка нужен нам самим.** Официальные ct-скрипты тянут `core@main` без пина. Для нашего инсталлятора безопаснее задать `COMMUNITY_SCRIPTS_CORE_URL=https://raw.githubusercontent.com/community-scripts/core/<sha или tag>` на второй строке скрипта (как DevScripts пинит `_CS_DEFAULT_URL`), чтобы изменения engine не ломали нас внезапно. Цена: мы сами обновляем пин. `/usr/bin/update` в контейнере запекает оба URL при установке, так что контейнер будет обновляться с тех же баз.

4. **Побочные эффекты чужого движка, о которых надо знать.** (a) Телеметрия: движок шлёт install/update-события на API community-scripts, если пользователь не отказался (`diagnostics_check` в меню, файл `/usr/local/community-scripts/diagnostics`, переменная `TELEMETRY_URL` переопределяет endpoint). (b) Проверки статуса скрипта по slug в PocketBase (`runtime_script_status_guard`) и `community-scripts.org/api/update-info?slug=` в `misc/update.sh`: для неизвестного slug они "fail open" (пустой `items` → `return 0`; `unknown` → обычное обновление), то есть нам не мешают, но лишний сетевой вызов остаётся. (c) Брендинг: `description()` в `pve/backend.func` пишет в notes контейнера логотип и бейджи community-scripts с donate-ссылкой, `motd_ssh` в MOTD печатает "Provided by: community-scripts ORG". `detect_repo_source` для чужого owner выставляет `REPO_SOURCE="external"` и ссылки GitHub/Issues в description ведут на наш репозиторий (через `REPO_SLUG`), но лого и donate остаются. Переопределить можно, объявив свою `description()` после `source build.func` (bash берёт последнее определение), но это наш приём, в upstream прецедента нет (не подтверждено как поддерживаемый путь).

5. **LXC unprivileged подходит для нашей нагрузки.** Все 651 `ct/*.sh` в ProxmoxVE по умолчанию `var_unprivileged=1`; движок всегда включает `nesting=1` (нужно systemd) и `keyctl=1` для unprivileged. Node 22, git, gh и Claude Code CLI не требуют Docker, FUSE и devices. Ограничения, которые касаются нас: `/proc/meminfo` показывает лимит CT через lxcfs (movement `setup_nodejs` сам ставит `NODE_OPTIONS=--max-old-space-size` в 75% от него, что полезно для нашего orchestrator с множеством дочерних процессов); cgroup `memory.max` внутри CT читается как `max` (важно только для JVM, нам нет). VM-вариант (`pve/vm-app.func`) существует, но обновляется "run the CT script URL directly inside the VM", без `/usr/bin/update`, и README прямо говорит "VM scripts have no built-in updater".

6. **Обновление: один механизм на установку и апдейт.** Тот же `ct/auto-dev.sh` при запуске на PVE-хосте создаёт контейнер, а внутри контейнера (нет `pveversion`) идёт в `update_script()`. `/usr/bin/update` генерируется `write_update_entrypoint` при установке и после каждого успешного апдейта. Версия хранится в `~/.auto-dev` (пишет `fetch_and_deploy_gh_release`), `check_for_gh_release` сравнивает её с GitHub releases и возвращает 0, если есть новее. Массовое обновление с хоста делает `tools/pve/update-apps.sh` через `pct exec <ct> -- bash -c "export PHS_SILENT=1;update;"`.

7. **Node.js пиним через `NODE_VERSION="22" setup_nodejs`** (NodeSource `node_22.x`, запись в `/var/cache/app-versions/nodejs_version.txt`, на апдейте тот же вызов обновит minor/patch или сделает чистый upgrade major). В `update_script` его надо звать снова: upstream делает так в n8n, uptime-kuma, actualbudget.

### Рекомендуемый скелет для auto-dev

Репозиторий auto-dev (или отдельный `auto-dev-proxmox`), структура как у DevScripts, чтобы walk-up в `core/build.func` нашёл корень по паре каталогов `ct/` + `install/`:

```
proxmox/
  ct/auto-dev.sh
  install/auto-dev-install.sh
  json/auto-dev.json        # опционально, только для совместимости с генератором сайта; в рантайме не читается
```

Команда для пользователя (одна строка, выполняется на PVE-хосте от root):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/core/main/tools/run.sh)" -- \
  https://raw.githubusercontent.com/<org>/auto-dev/main/proxmox ct/auto-dev.sh \
  https://raw.githubusercontent.com/community-scripts/core/<pinned-sha>
```

или эквивалент без `run.sh`: `COMMUNITY_SCRIPTS_URL=... COMMUNITY_SCRIPTS_CORE_URL=... bash -c "$(curl -fsSL .../ct/auto-dev.sh)"`.

`ct/auto-dev.sh` (по шаблону DevScripts `AGENTS.md` и реальному `ct/uptimekuma.sh`):

```bash
#!/usr/bin/env bash
_CS_DEFAULT_URL="https://raw.githubusercontent.com/<org>/auto-dev/main/proxmox"
_CS_CORE_DEFAULT_URL="https://raw.githubusercontent.com/community-scripts/core/<pinned-sha>"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-$_CS_CORE_DEFAULT_URL}/core/build.func")
# License: MIT | Source: https://github.com/<org>/auto-dev

APP="auto-dev"
var_tags="${var_tags:-dev-tools;ai}"
var_cpu="${var_cpu:-4}"
var_ram="${var_ram:-4096}"
var_disk="${var_disk:-20}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"
var_arm64="${var_arm64:-yes}"

# Входные параметры установки (без export не дойдут до контейнера через lxc-attach)
export var_product_repo="${var_product_repo:-}"
export var_anthropic_api_key="${var_anthropic_api_key:-}"
export var_gh_token="${var_gh_token:-}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -d /opt/auto-dev ]]; then
    msg_error "No auto-dev Installation Found!"
    exit
  fi

  NODE_VERSION="22" setup_nodejs

  if check_for_gh_release "auto-dev" "<org>/auto-dev"; then
    msg_info "Stopping auto-dev"
    systemctl stop auto-dev
    msg_ok "Stopped auto-dev"

    create_backup /opt/auto-dev/.env
    CLEAN_INSTALL=1 CLEAN_INSTALL_KEEP="data" fetch_and_deploy_gh_release "auto-dev" "<org>/auto-dev" "tarball"
    restore_backup

    cd /opt/auto-dev
    $STD npm ci --omit dev
    $STD npm install -g @anthropic-ai/claude-code@latest

    msg_info "Starting auto-dev"
    systemctl start auto-dev
    msg_ok "Started auto-dev"
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:3000${CL}"
```

`install/auto-dev-install.sh`:

```bash
#!/usr/bin/env bash
source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
$STD apt install -y git gh
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs
fetch_and_deploy_gh_release "auto-dev" "<org>/auto-dev" "tarball"

msg_info "Installing auto-dev"
cd /opt/auto-dev
$STD npm ci --omit dev
$STD npm install -g @anthropic-ai/claude-code@latest
mkdir -p /opt/auto-dev/data
cat <<EOF >/opt/auto-dev/.env
PORT=3000
PRODUCT_REPO=${var_product_repo}
ANTHROPIC_API_KEY=${var_anthropic_api_key}
GH_TOKEN=${var_gh_token}
EOF
msg_ok "Installed auto-dev"

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/auto-dev.service
[Unit]
Description=auto-dev orchestrator
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/auto-dev
EnvironmentFile=/opt/auto-dev/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/auto-dev/dist/server.js
Restart=on-failure
RestartSec=5
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now auto-dev
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
```

Поток обновления для пользователя: в консоли контейнера `update` (или с хоста `pct exec <ctid> -- update`). Это запускает `/usr/bin/update` → `misc/update.sh` из core → `bash -c "$(curl ${COMMUNITY_SCRIPTS_URL}/ct/auto-dev.sh)"` → `start()` видит, что это контейнер → `_cs_run_update` → наш `update_script()`.

Что не покрывается upstream-механикой и остаётся на нас: (a) `gh` ставится из apt Debian 13 (есть пакет `gh`, но версия может отставать; альтернатива: `fetch_and_deploy_gh_release "gh" "cli/cli" "binary"` ставит .deb с GitHub Releases); (b) обновление Claude Code CLI делаем в `update_script` через `npm install -g`; (c) пин версии core и его периодическое обновление.

---

## 1. Структура репозитория

### 1.1. Движок переехал в `community-scripts/core`

`core/README.md`: "This repository holds the shared Bash libraries that every community script runs on: the whiptail wizard, container and VM creation, the in-container installer, error handling, telemetry and the helper library. You do not run anything from here directly."

Карта репозиториев из того же README:

| Repository | Contains |
| --- | --- |
| core | The engine |
| ProxmoxVE | Application scripts: `ct/`, `install/`, `vm/`, `json/`, `tools/pve/` |
| DevScripts | Where new scripts are tested before they move to ProxmoxVE |
| Incus | Incus scripts and host tooling |

Источник: `CORE/README.md`.

Примечание про `json/`: README core упоминает `json/` в ProxmoxVE, но дерево ProxmoxVE на `06b788e` каталога `json/` не содержит (GitHub API `/contents/json` → 404, `/contents/frontend` → 404). `ProxmoxVE/CONTRIBUTING.md`: "Website metadata (name, description, logo, tags) is managed via the website - use the Report Issue link on any script page to request changes. Do not submit metadata changes via repo files." В DevScripts `json/<app>.json` обязателен (109 файлов на `ad79458`), см. 1.5.

Верхний уровень ProxmoxVE (`06b788e`): `.github/`, `ct/` (651 скрипт), `install/` (635), `tools/addon/`, `tools/copy-data/`, `tools/pve/`, `turnkey/`, `vm/` (20 скриптов), `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `SECURITY.md`.

### 1.2. Файлы движка и их назначение

Таблица "Every file" из `CORE/docs/README.md` (сокращённо, только то, что важно для нас):

| Файл | Назначение |
| --- | --- |
| `core/build.func` | "Entry point: resolves both roots, prefetches the engine, dispatches to a platform backend" |
| `core/core.func` | "Colours, icons, `msg_*`, spinner, `silent()`, logging, prompts" |
| `core/error_handler.func` | "`catch_errors`, the ERR trap, signal handlers, container failure artifacts" |
| `ui/build-ui.func` | "Wizard entry point; sources the four parts below" (`validate`, `defaults`, `advanced`, `menu`) |
| `ui/menu.func` | "`start`, `install_script`, settings and diagnostics menus" |
| `lib/tools.func` | "Helper library entry point; sources the five parts below" (`system`, `forge`, `runtime`, `db`, `hwaccel`) |
| `lib/forge.func` | "Releases, tags and branches from GitHub, GitLab and Codeberg" |
| `lib/runtime.func` | "Language runtimes and application installers" (`setup_nodejs` и т.п.) |
| `lxc/install.func` | "In-container bootstrap, every distro including Alpine" |
| `pve/backend.func` | "Container creation via `pct`" (бывший `create_lxc.sh` + `build_container`) |
| `pve/vm-core.func` | "VM creation via `qm`" |
| `pve/vm-app.func` | "Running LXC applications inside a VM" |
| `api/api.func` | "Telemetry entry point" |
| `misc/update.sh` | "The `update` helper: decides whether an app can still be updated before pulling anything" |

Соответствие старым именам: `misc/build.func` → `core/build.func` + `ui/*.func` + `pve/backend.func`; `misc/install.func` → `lxc/install.func`; `misc/core.func` → `core/core.func`; `misc/api.func` → `api/api.func`; `misc/tools.func` → `lib/tools.func` (loader) + `lib/{system,forge,runtime,db,hwaccel}.func`; `misc/create_lxc.sh` → `create_lxc_container()` в `pve/backend.func`.

### 1.3. `core/build.func`: две корневые точки

Заголовок файла (`CORE/core/build.func`):

```bash
# The engine (this repo, community-scripts/core) and the scripts (ProxmoxVE,
# DevScripts, Incus) live in SEPARATE repositories, so a single origin can no
# longer address both. Everything below distinguishes two roots:
#
#   ENGINE  - shared/ pve/ incus/     → core
#   SCRIPTS - ct/ install/ vm/        → whichever script repo invoked us
#
#   COMMUNITY_SCRIPTS_CORE_URL / COMMUNITY_SCRIPTS_CORE_DIR   → engine
#   COMMUNITY_SCRIPTS_URL      / COMMUNITY_SCRIPTS_ROOT       → scripts

_CS_DEFAULT_URL="${_CS_DEFAULT_URL:-https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main}"
_CS_CORE_DEFAULT_URL="${_CS_CORE_DEFAULT_URL:-https://raw.githubusercontent.com/community-scripts/core/main}"

_cs_is_engine_path() {
  case "${1:-}" in
  core/* | lxc/* | host/* | api/* | lib/* | ui/* | vm/* | pve/* | incus/*) return 0 ;;
  *) return 1 ;;
  esac
}
```

Порядок резолва (`CORE/docs/loading.md`): "1. Local checkout - used when found, so development needs no network at all. 2. Git origin - a checkout's own remote and branch become its raw base, so a fork or branch is picked up automatically. GitHub remotes only. 3. Defaults - `community-scripts/core@main` for the engine, `community-scripts/ProxmoxVE@main` for the scripts. DevScripts and Incus scripts override the latter with `_CS_DEFAULT_URL` on their second line."

Корень скриптов определяется walk-up: "Walk up to the first directory holding both ct/ and install/" (`CORE/core/build.func`). Движок префетчится целиком (`_CS_ENGINE_FILES`, `curl --parallel` в `/dev/shm`), затем `_cs_source_func "ui/build-ui.func"` и `_cs_source_func "pve/backend.func"` на PVE-хосте.

### 1.4. Стандартный заголовок ct-скрипта и поток вызовов

Реальный `PVE/ct/n8n.sh`:

```bash
#!/usr/bin/env bash
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) 2021-2026 tteck
# Author: tteck (tteckster)
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Source: https://n8n.io/ | Github: https://github.com/n8n-io/n8n

APP="n8n"
var_tags="${var_tags:-automation}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-10}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-yes}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  ...
  exit
}

start
build_container
description
```

Переменные заголовка:

| Переменная | Смысл | Где читается |
| --- | --- | --- |
| `APP` | отображаемое имя; `variables()` делает `NSAPP=$(echo "${APP,,}" \| tr -d ' ')` и `var_install="${NSAPP}-install"`, то есть имя install-скрипта выводится из `APP` | `CORE/ui/build-ui.func` |
| `var_tags` | теги контейнера; `base_settings` добавляет `community-script` впереди: `TAGS="community-script${var_tags:+;${var_tags}}"` | `CORE/ui/defaults.func` |
| `var_cpu`, `var_ram`, `var_disk` | минимумы; `variables()` сохраняет их в `APP_DEFAULT_*`, `base_settings` берёт максимум из app-значения и значения из `.vars`: "If app declared higher values, use those instead" | `CORE/ui/build-ui.func`, `CORE/ui/defaults.func` |
| `var_os`, `var_version` | тип и версия шаблона; `TEMPLATE_SEARCH="${PCT_OSTYPE}-${PCT_OSVERSION}"`; внутри контейнера берутся из `/etc/os-release` | `CORE/pve/backend.func`, `CORE/core/build.func` |
| `var_unprivileged` | `CT_TYPE=${var_unprivileged:-"1"}` → `-unprivileged $CT_TYPE` в `pct create` | `CORE/ui/defaults.func` |
| `var_arm64` | три состояния `yes` / `no` / unset; на arm64-хосте unset означает интерактивный вопрос, в unattended-режиме abort с exit 106 | `CORE/core/core.func` (`arch_check`) |
| `var_fuse`, `var_tun`, `var_gpu`, `var_nesting`, `var_keyctl`, `var_mknod`, `var_mount_fs`, `var_protection`, `var_cmode`, `var_timezone`, `var_brg`, `var_net`, `var_gateway`, `var_vlan`, `var_mtu`, `var_ssh`, `var_ssh_authorized_key`, `var_pw`, `var_ctid`, `var_hostname`, `var_template_storage`, `var_container_storage`, `var_testurl` | дополнительные, все читаются в `base_settings` | `CORE/ui/defaults.func` |

Семь lifecycle-вызовов (сайт `community-scripts.org/docs/ct/detailed_guide`, пересказ): `header_info` печатает баннер; `variables` нормализует OS, выводит имена и фиксирует CPU/RAM/disk; `color` задаёт цвета; `catch_errors` ставит трапы; `start` запускает preflight и wizard, а в существующем контейнере идёт в update-path и завершает работу; `build_container` создаёт контейнер и выполняет install-скрипт; `description` пишет notes и шлёт финальную телеметрию. "Each step depends on the one before it, so moving a call earlier or later breaks the flow."

`catch_errors` (`CORE/core/error_handler.func`):

```bash
catch_errors() {
  set -Ee -o pipefail
  if [ "${STRICT_UNSET:-0}" = "1" ]; then
    set -u
  fi
  trap 'error_handler' ERR
  trap on_exit EXIT
  trap on_interrupt INT
  trap on_terminate TERM
  trap on_hangup HUP
}
```

`start` (`CORE/ui/menu.func`), ветвление хост / контейнер:

```bash
start() {
  _cs_source_func "lib/tools.func"
  ...
  if command -v pveversion >/dev/null 2>&1; then
    runtime_script_status_guard install || return 0
    install_script || return 0
    return 0
  elif [[ "$_cs_platform" == "pve" || "$_cs_platform" == "incus" ]]; then
    msg_error "This is a ${_cs_platform} host, not a container - refusing to update it"
    ...
  elif [ ! -z ${PHS_SILENT+x} ] && [[ "${PHS_SILENT}" == "1" ]]; then
    VERBOSE="no"; set_std_mode; _cs_run_update
  elif ! [ -t 0 ] || [[ "$TERM" == "dumb" ]]; then
    msg_custom "ℹ️" "${YW}" "No interactive terminal detected - defaulting to silent update mode"
    VERBOSE="no"; set_std_mode; _cs_run_update
  ...
  else
    CHOICE=$(whiptail --backtitle "Proxmox VE Helper Scripts" --title "${APP} LXC Update/Setting" --menu \
      "Support/Update functions for ${APP} LXC. Choose an option:" 12 60 3 \
      "1" "YES (Silent Mode)" "2" "YES (Verbose Mode)" "3" "NO (Cancel Update)" ...)
    ...
    _cs_run_update
  fi
}
```

`install_script` на хосте: `shell_check`, `root_check`, `pve_check`, `ensure_whiptail`, `arch_check`, `arm64_notice`, `ssh_check`, `maxkeys_check`, `storage_content_check`, `diagnostics_check`, затем меню whiptail "Community-Scripts Options" с пунктами `1 Default Install`, `2 Advanced Install`, `3 User Defaults`, `4 App Defaults for <APP>` (если есть файл), `Settings`. Пресет можно передать без меню: `CHOICE="${mode:-${1:-}}"` (значения `default`, `advanced`, `mydefaults`, `appdefaults`, `generated`). Источник: `CORE/ui/menu.func`.

### 1.5. Метаданные `json/<app>.json` (DevScripts)

Пример `DEV/json/aiostreams.json`:

```json
{
  "name": "AIOStreams",
  "slug": "aiostreams",
  "categories": [13],
  "date_created": "2026-08-10",
  "type": "ct",
  "updateable": true,
  "privileged": false,
  "architectures": ["amd64", "arm64"],
  "interface_port": 3000,
  "documentation": "https://docs.aiostreams.viren070.me/",
  "website": "https://github.com/Viren070/AIOStreams",
  "repository": "https://github.com/Viren070/AIOStreams",
  "logo": "https://cdn.jsdelivr.net/gh/selfhst/icons@main/webp/aiostreams.webp",
  "description": "...",
  "install_methods": [
    {
      "type": "default",
      "script": "ct/aiostreams.sh",
      "config_path": "/opt/aiostreams_data/.env",
      "resources": { "cpu": 2, "ram": 2048, "hdd": 8, "os": "Debian", "version": "13" }
    }
  ],
  "default_credentials": { "username": null, "password": null },
  "notes": [ { "text": "...", "type": "warning" } ]
}
```

`DEV/AGENTS.md`: "`updateable` boolean: Whether update_script is implemented", "`app_vars` array (optional): Values the install script accepts up front, so a deployment can run unattended". `app_vars` формата `{ "name": "var_admin_user", "label": "Admin Username", "type": "text", "default": "admin" }`, `type` из `text`, `password`, `number`, `boolean`, `select`. `DEV/docs/guides/source-origin.md`: "`json/` is website metadata and plays no part at run time."

---

## 2. Как ct-скрипт создаёт LXC и запускает install-скрипт

### 2.1. `build_container()` в `pve/backend.func`

Сетевые дефолты и features (`CORE/pve/backend.func`, функция `build_container`, начало на строке 444):

```bash
  NET_STRING="-net0 name=eth0,bridge=${BRG:-vmbr0}"
  ...
  # IP (always required, default dhcp)
  NET_STRING+=",ip=${NET:-dhcp}"
  ...
  # Nesting support (user configurable, default enabled)
  if [ "${ENABLE_NESTING:-1}" == "1" ]; then
    FEATURES="nesting=1"
  fi

  # Keyctl for unprivileged containers (needed for Docker)
  if [ "$CT_TYPE" == "1" ]; then
    [ -n "$FEATURES" ] && FEATURES="$FEATURES,"
    FEATURES="${FEATURES}keyctl=1"
  fi

  if [ "$ENABLE_FUSE" == "yes" ]; then
    [ -n "$FEATURES" ] && FEATURES="$FEATURES,"
    FEATURES="${FEATURES}fuse=1"
  fi
```

Дефолты из `base_settings` (`CORE/ui/defaults.func`): `CT_TYPE=${var_unprivileged:-"1"}`, `DISK_SIZE` 4, `CORE_COUNT` 1, `RAM_SIZE` 1024 (если app не задал больше), `HN="$NSAPP"`, `BRG=${var_brg:-"vmbr0"}`, `NET=${var_net:-"dhcp"}`, `IPV6_METHOD=${var_ipv6_method:-"none"}`, `SSH=${var_ssh:-"no"}`, `ENABLE_FUSE=${var_fuse:-no}`, `ENABLE_TUN=${var_tun:-no}`, `ENABLE_NESTING=${var_nesting:-"1"}`, `CT_ID="${var_ctid:-$NEXTID}"` (из `pvesh get /cluster/nextid`).

Собираемые опции `pct create`:

```bash
  PCT_OPTIONS_STRING="$PCT_OPTIONS_STRING
  $NET_STRING
  -onboot 1
  -cores $CORE_COUNT
  -memory $RAM_SIZE
  -unprivileged $CT_TYPE"
```

Экспорт окружения для контейнера (там же):

```bash
  export FUNCTIONS_FILE_PATH="$(_cs_fetch_text "lxc/install.func")"
  export DIAGNOSTICS="$DIAGNOSTICS"
  export RANDOM_UUID="$RANDOM_UUID"
  ...
  export tz="$timezone"
  export APPLICATION="$APP"
  export app="$NSAPP"
  export PASSWORD="$PW"
  export VERBOSE="$VERBOSE"
  export SSH_ROOT="${SSH}"
  export SSH_AUTHORIZED_KEY
  export CTID="$CT_ID"
  export CTTYPE="$CT_TYPE"
  export ENABLE_FUSE="$ENABLE_FUSE"
  export ENABLE_TUN="$ENABLE_TUN"
  export PCT_OSTYPE="$var_os"
  export PCT_OSVERSION="$var_version"
  ...
  export COMMUNITY_SCRIPTS_URL="$COMMUNITY_SCRIPTS_URL"
  export COMMUNITY_SCRIPTS_CORE_URL="$COMMUNITY_SCRIPTS_CORE_URL"
  ...
  export MODE="${METHOD:-default}"
```

`FUNCTIONS_FILE_PATH` это не путь, а весь текст `lxc/install.func`, переданный через переменную окружения. `CORE/docs/lxc.md`: "The host passes the file through the environment (`FUNCTIONS_FILE_PATH`), which `lxc-attach` carries into the container."

### 2.2. Шаблон и storage (`create_lxc_container`, строка 2731)

```bash
    TEMPLATE_SEARCH="${PCT_OSTYPE}-${PCT_OSVERSION:-}"
    case "$PCT_OSTYPE" in
    debian | ubuntu) TEMPLATE_PATTERN="-standard_" ;;
    alpine | fedora | rocky | centos) TEMPLATE_PATTERN="-default_" ;;
    *) TEMPLATE_PATTERN="" ;;
    esac

    msg_info "Searching for template '$TEMPLATE_SEARCH'"
    # Step 1: Check local templates first (instant)
    mapfile -t LOCAL_TEMPLATES < <(
      pveam list "$TEMPLATE_STORAGE" 2>/dev/null |
        awk -v search="${TEMPLATE_SEARCH}" -v pattern="${TEMPLATE_PATTERN}" -v arch="${ARCH}" \
          '$1 ~ search && $1 ~ pattern && $1 ~ ("_" arch "\\.(tar\\.zst|tar\\.xz|tar\\.gz)$") {print $1}' |
        sed 's|.*/||' | sort -t - -k 2 -V || true
    )
```

Если локального нет, идёт `pveam available` / `pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"` (функция `download_template`), есть fallback на linuxcontainers.org для ОС без pveam-шаблона. Создание:

```bash
  set -f
  if ! _pct_create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" $PCT_OPTIONS ${_PW_ARGS[@]+"${_PW_ARGS[@]}"} >"$LOGFILE" 2>&1; then
```

Выбор storage (`select_storage`): читает `pvesm status -content rootdir` (контейнер) и `-content vztmpl` (шаблон); при единственном кандидате выбирает его без вопроса, иначе whiptail radiolist "Storage Pools": `--radiolist "Which storage pool for ${CONTENT_LABEL,,}?\n(Spacebar to select)"`. Преселект через `var_template_storage` и `var_container_storage` (экспортируются как `TEMPLATE_STORAGE` и `CONTAINER_STORAGE`). Источник: `CORE/pve/backend.func`.

Advanced settings: `advanced_settings` в `CORE/ui/advanced.func` ("one function, the full interactive configuration path", `CORE/docs/ui.md`), пункты: CT ID, hostname, disk, cores, RAM, bridge, IP, gateway, VLAN, MTU, DNS, MAC, SSH, FUSE, TUN, GPU, verbose и т.п.; после него `maybe_offer_save_app_defaults` предлагает сохранить `.vars` в `/usr/local/community-scripts/defaults/<app>.vars`.

### 2.3. Выполнение install-скрипта внутри контейнера

`CORE/pve/backend.func`, строки 1493-1516:

```bash
    if ! _install_script="$(_cs_fetch_text "install/${var_install}.sh")" ||
      [[ -z "$_install_script" ]]; then
      msg_error "Could not fetch install/${var_install}.sh"
      msg_custom "📁" "${YW}" "Looked in: ${COMMUNITY_SCRIPTS_ROOT:-${COMMUNITY_SCRIPTS_URL}}"
      if [[ -z "${COMMUNITY_SCRIPTS_ROOT:-}" ]]; then
        msg_custom "💡" "${YW}" "Running a fork? A ct/ script fetched with curl cannot tell the engine"
        msg_custom "   " "${YW}" "where it came from, so set the scripts base explicitly:"
        msg_custom "   " "${YW}" "COMMUNITY_SCRIPTS_URL=https://raw.githubusercontent.com/<you>/<repo>/<branch>"
      fi
      exit 115
    fi
    ...
    lxc-attach -n "$CTID" -- bash -c "printf '%s' \$\$ >/root/.install-${SESSION_ID}.pid
$_install_script"
    local lxc_exit=$?
```

То есть хост скачивает `install/<app>-install.sh` сам и передаёт его текст как аргумент `bash -c` через `lxc-attach` (контейнер ничего не тянет для install-скрипта). `DEV/docs/guides/source-origin.md`: "The host reads `install/<app>-install.sh` and pipes its contents into `lxc-attach`. The container never fetches it."

Результат читается по маркерам `/root/.install-<SESSION_ID>.failed` (с кодом выхода) и `.done`; при SIGHUP хоста установка продолжается, хост ждёт маркеры (`_pve_wait_for_detached_install`). Перед `lxc-attach` хост через `pct exec` ставит базовые пакеты, локаль и timezone (строки 1214-1260).

Install-скрипт начинается с:

```bash
source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os
```

`lxc/install.func` при `source` сразу выполняет `_bootstrap` (ставит curl при отсутствии, префетчит `_CS_CT_ENGINE_FILES` = `core/core.func core/error_handler.func api/exitcodes.func api/errorlog.func lib/tools.func lib/alpine.func lib/db.func lib/forge.func lib/hwaccel.func lib/runtime.func lib/system.func`, грузит `core.func`, `error_handler.func`, вызывает `catch_errors`, `get_lxc_ip`) и `detect_os`. `update_os` после `pkg_update`/`pkg_upgrade` подключает `lib/tools.func` (или `lib/alpine.func`). `verb_ip6` вызывает `set_std_mode`, где `STD="silent"`. Источник: `CORE/lxc/install.func`, `CORE/core/core.func`.

Завершение install-скрипта: `motd_ssh` (пишет `/etc/profile.d/00_lxc-details.sh` и `/etc/motd`), `customize` (autologin root, если пароль пуст; генерирует `/usr/bin/update` через `write_update_entrypoint "$app" "$update_script_name"`; кладёт `SSH_AUTHORIZED_KEY`), `cleanup_lxc` (чистит кэши apt/npm/pnpm/pip и т.п.).

### 2.4. VM-вариант

Два разных механизма:

1. `vm/*.sh` в ProxmoxVE (20 скриптов: debian, ubuntu, docker, haos, opnsense и др.). Это не ct-скрипты: `source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-...}/pve/vm-core.func")`, затем `load_functions`, свои `default_settings`/`advanced_settings`, `vm_start_script`, `vm_select_storage`, `vm_fetch_image` (cloud image qcow2), `qm create ... -agent 1 -bios ovmf ...`, `qm importdisk`, `qm set`, опционально `setup_cloud_init`. Пример `PVE/vm/debian-vm.sh`:

```bash
qm create $VMID -agent 1${MACHINE} -tablet 0 -localtime 1 -bios ovmf${CPU_TYPE} -cores $CORE_COUNT -memory $RAM_SIZE \
  -name $HN -tags community-script,debian${var_version} -net0 virtio,bridge=$BRG,macaddr=$MAC$VLAN$MTU -onboot 1 -ostype l26 -scsihw virtio-scsi-pci
vm_alloc_efi_disk "$DISK0"
qm importdisk $VMID ${FILE} $STORAGE ${DISK_IMPORT:-} 1>&/dev/null
```

`PVE/README.md`: "VM scripts have no built-in updater - use the guest's own package manager."

2. `pve/vm-app.func`: запуск LXC-приложения внутри VM. Шапка файла (`CORE/pve/vm-app.func`):

```
# How it works:
#   1. Creates a VM with a cloud image (Debian 12/13, Ubuntu 22.04/24.04)
#   2. Uses virt-customize to inject dependencies and run the install script LIVE
#   3. For updates: run the CT script URL directly inside the VM
```

`customize_vm_image` заливает в образ `lxc/install.func` и `lib/tools.func`, пишет wrapper с теми же export (`FUNCTIONS_FILE_PATH`, `APPLICATION`, `app`, `CTTYPE="1"`, `COMMUNITY_SCRIPTS_URL`, `DEPLOY_TARGET="vm"`) и выполняет `curl -fsSL "${COMMUNITY_SCRIPTS_URL}/install/${app}-install.sh" | bash` через `virt-customize --run`. Метаданные берёт grep'ом из ct-скрипта (`get_app_metadata`: `^APP=`, `^var_cpu=...`). Отдельного `vm/<app>-vm.sh` для каждого приложения нет; в ProxmoxVE `vm/` только базовые ОС и appliance.

---

## 3. Механизм обновления

### 3.1. Как пользователь запускает

`PVE/README.md`: "Every container gets an `update` command. Type it in the container console: `update`". Технически `update` = `/usr/bin/update`, сгенерированный `write_update_entrypoint` (`CORE/core/core.func`):

```bash
  cat >"$tmp" <<EOF
#!/usr/bin/env bash
# Community-Scripts update entrypoint (generated - do not edit by hand).
# Regenerated on install and on every successful update.
export SCRIPT_SLUG="${slug}"
export UPDATE_SCRIPT_NAME="${name}"
export COMMUNITY_SCRIPTS_URL="${base}"
export COMMUNITY_SCRIPTS_CORE_URL="${core_url}"
export COMMUNITY_SCRIPTS_WEBSITE_URL="${website}"
EOF
  cat >>"$tmp" <<'EOF'
_cs_helper="$(curl -fsSL --connect-timeout 10 "${COMMUNITY_SCRIPTS_CORE_URL}/misc/update.sh" 2>/dev/null)"
if [[ -n "$_cs_helper" ]]; then
  bash -c "$_cs_helper"
else
  echo "Update helper unavailable - falling back to direct update."
  bash -c "$(curl -fsSL "${COMMUNITY_SCRIPTS_URL}/ct/${UPDATE_SCRIPT_NAME}.sh")"
fi
EOF
  chmod +x "$tmp"
  mv -f "$tmp" /usr/bin/update
```

`CORE/docs/updates.md`: "It bakes in the values that run needs, so the container keeps pulling from whatever it was built from rather than from today's defaults." Вызов при установке: в `customize()` (`CORE/lxc/install.func`): `local update_script_name="${app:-${var_os:-}}"; write_update_entrypoint "$app" "$update_script_name"`. После апдейта: `_cs_run_update` вызывает `migrate_update_entrypoint`, который перегенерирует файл.

`misc/update.sh` (`CORE/misc/update.sh`): спрашивает `${WEBSITE}/api/update-info?slug=${SLUG}`; при `deleted` не тянет скрипт; при `active | disabled | unknown` или недоступном сайте выполняет `run_app_update` → `bash -c "$(curl -fsSL "${BASE}/ct/${resolved}.sh")"`. Комментарий в коде: "`unknown` means no catalog record for this slug, NOT that the script was removed ... fail open to the normal update".

Да, это по сути повторный запуск того же `bash -c "$(curl .../ct/<app>.sh)"` внутри контейнера. Ручной запуск той же строки в контейнере тоже работает (`CORE/docs/updates.md`: "they also cover the case where someone runs the `ct/` one-liner by hand instead of `update`").

Внутри ct-скрипта `start()` видит отсутствие `pveversion`, показывает whiptail "YES (Silent Mode) / YES (Verbose Mode) / NO" (или при `PHS_SILENT=1` / без TTY идёт в silent) и вызывает `_cs_run_update` (`CORE/ui/menu.func`):

```bash
_cs_run_update() {
  ensure_profile_loaded
  ensure_recorded_toolchains
  get_lxc_ip
  migrate_update_entrypoint
  runtime_script_status_guard update || exit 0
  check_container_os_guard || exit 0
  check_breaking_change_guard || exit 0
  apt_conffile_guard
  _CS_UPDATE_CLEANUP=1
  update_script
  run_addon_updates
  update_motd_ip
  exit 0
}
```

`ensure_recorded_toolchains` переустанавливает runtime, если бинарь пропал: "nodejs) bin=node fn=setup_nodejs" по записям в `/var/cache/app-versions/*_version.txt`.

Массовое обновление с хоста: `PVE/tools/pve/update-apps.sh`: `UPDATE_CMD="update;"`, в unattended-режиме `UPDATE_CMD="export PHS_SILENT=1;update;"`, затем `pct exec "$container" -- bash -c "${SETUP_CMD}${UPDATE_CMD}"`. Имя сервиса определяется из `/usr/bin/update` (`pct pull`, `sed 's/^export UPDATE_SCRIPT_NAME=.../'`). Контейнеры находятся по тегам `community-script|proxmox-helper-scripts` (`var_tags`). Dry-run читает `~/.<app>` в контейнере и сравнивает с `api.github.com/repos/<repo>/releases/latest`.

### 3.2. Как определяется установленная версия

Стандарт: файл `~/.<app>` (точнее `$HOME/.${app_lc}`, где `app_lc` = lowercase без пробелов). `CORE/docs/lib.md`: "Both entry points keep a version stamp in `~/.<app>`. It is written when the deploy finishes ... the marker `~/.<app>.pending` beside it holds the version the run started from and stays until a run that deployed exits cleanly. `check_for_release` redoes the update while the marker exists, and both helpers export `CS_PREVIOUS_VERSION`."

Legacy `/opt/<app>_version.txt` мигрируется автоматически в `check_for_release` (`CORE/lib/forge.func`):

```bash
  local current="" legacy_files=()
  if [[ -f "$current_file" ]]; then
    current="$(<"$current_file")"
  else
    mapfile -t legacy_files < <(find /opt -maxdepth 1 -type f -name "*_version.txt" 2>/dev/null)
    if ((${#legacy_files[@]} == 1)); then
      current="$(_forge_strip_v "$(<"${legacy_files[0]}")")"
      echo "$current" >"$current_file"
      rm -f "${legacy_files[0]}"
    fi
  fi
```

Проверка "установлено ли вообще" делается в самом `update_script` по наличию каталога/юнита: `[[ ! -d /opt/uptime-kuma ]]`, `[[ ! -f /etc/systemd/system/n8n.service ]]`, `[[ ! -f ~/.actualbudget && ! -f /opt/actualbudget_version.txt ]]` (`PVE/ct/uptimekuma.sh`, `PVE/ct/n8n.sh`, `PVE/ct/actualbudget.sh`).

### 3.3. Helper-функции

`check_for_gh_release` = обёртка над `check_for_release github ...`:

```bash
# check_for_release <forge> <app> <repo> [pinned] [pin_reason] [tag_prefix]
# - Returns 0 when an update is available, non-zero otherwise
# - Sets CHECK_UPDATE_RELEASE to the RAW tag; callers strip the v themselves
```

Берёт release, помеченный latest (`_forge_designated_release`), учитывает `GH_INCLUDE_PRERELEASE=1`, печатает `msg_ok "Update available: ${app} ${current:-not installed} -> ${latest_clean}"` или `msg_ok "No update available: ${app} (${current})"` и возвращает 1. Источник: `CORE/lib/forge.func`.

`fetch_and_deploy_gh_release` = `fetch_and_deploy_release github "$1" "$2" "${3:-tarball}" "${4:-latest}" "${5:-}" "${6:-}" "${7:-}"`:

```
#   fetch_and_deploy_release <forge> <app> <repo> [mode] [version] [target]
#                            [asset_pattern] [tag_prefix]
# - modes: tarball (default), binary, prebuild, singlefile
```

Дефолт `target="/opt/$app"`, версия `"${var_appversion:-${5:-latest}}"`, в конце `echo "$version" >"$version_file"; msg_ok "Deployed: $app ($version)"`. Если уже стоит та же версия и `FORCE_UPDATE` не задан: `msg_ok "${app} ${version} already installed"; return 0`. Режим `binary` ставит `.deb` под `SYSTEMD_OFFLINE=1`. `CLEAN_INSTALL=1` и `CLEAN_INSTALL_KEEP="data uploads"` управляют очисткой target (`DEV/AGENTS.md`, пункт 19). Также есть `fetch_and_deploy_gh_tag`, `fetch_and_deploy_gh_branch`, `fetch_and_deploy_from_url`, `get_latest_github_release "<owner/repo>" [strip_v]`.

`$STD`: `set_std_mode` ставит `STD="silent"`; `silent()` (`CORE/core/core.func`) выполняет команду с выводом в лог (`get_active_logfile`), а при `VERBOSE=yes` дублирует вывод на экран через `tee`; при ошибке запоминает `_SILENT_FAILED_CMD/LINE/LOG`, чтобы `error_handler` показал реальную команду. `msg_info` открывает блок со спиннером и логирует `[INFO]`, `msg_ok` закрывает; `DEV/AGENTS.md` п.34: "Every `msg_info` opens a block that exactly one `msg_ok` (or a `msg_error` that ends the script) closes."

Пример реального `update_script` с остановкой и запуском сервиса (`PVE/ct/uptimekuma.sh`):

```bash
function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -d /opt/uptime-kuma ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  NODE_VERSION="22" setup_nodejs

  ensure_dependencies chromium
  ...
  if check_for_gh_release "uptime-kuma" "louislam/uptime-kuma"; then
    msg_info "Stopping Service"
    systemctl stop uptime-kuma
    msg_ok "Stopped Service"

    fetch_and_deploy_gh_release "uptime-kuma" "louislam/uptime-kuma" "tarball"

    msg_info "Updating Uptime Kuma"
    cd /opt/uptime-kuma
    $STD npm install --omit dev
    $STD npm run download-dist
    msg_ok "Updated Uptime Kuma"

    msg_info "Starting Service"
    systemctl start uptime-kuma
    msg_ok "Started Service"
    msg_ok "Updated successfully!"
  fi
  exit
}
```

`check_container_resources` сравнивает `/proc/meminfo` и `nproc` с `var_ram`/`var_cpu` и при недостатке спрашивает (`prompt_confirm`, в unattended-режиме прерывает с exit 113); `check_container_storage` прерывает при заполнении `/` более 80% без подтверждения (exit 114). Источник: `CORE/ui/menu.func`.

---

## 4. Self-hosting вне официального репозитория

### 4.1. Официально поддерживаемые способы

`CORE/docs/loading.md`, раздел "Running against a fork":

```bash
# Remote fork, scripts only
export COMMUNITY_SCRIPTS_URL=https://raw.githubusercontent.com/YOU/DevScripts/my-branch
bash -c "$(curl -fsSL "$COMMUNITY_SCRIPTS_URL/ct/debian.sh")"

# Remote fork, both sides
curl -fsSL https://raw.githubusercontent.com/community-scripts/core/main/tools/run.sh |
  bash -s -- https://raw.githubusercontent.com/YOU/ProxmoxVE/my-branch ct/debian.sh \
             https://raw.githubusercontent.com/YOU/core/my-branch
```

"Fetching the ct script from a fork does not tell the engine where that fork is. With `bash -c "$(curl …)"` there is no file on disk, so the walk-up that finds the scripts root has nothing to walk and `COMMUNITY_SCRIPTS_URL` falls back to the default."

"A private fork cannot be used this way at all: `_cs_download` sends no authentication header, so `raw.githubusercontent.com` answers 404. Use a local checkout for those."

`DEV/docs/guides/source-origin.md`, "Other hosts": "`COMMUNITY_SCRIPTS_URL` is a plain base URL, so any host that serves raw files works. Only GitHub remotes are detected automatically from a checkout; for anything else, set it yourself: `export COMMUNITY_SCRIPTS_URL=https://files.example.com/YOU/DevScripts/raw/your-branch`".

Там же про `/usr/bin/update`: "is written with whatever `COMMUNITY_SCRIPTS_URL` was set to at install time. On a private fork the install itself succeeds, but running `update` in the container later hits a 404."

`CORE/tools/run.sh` целиком делает `export COMMUNITY_SCRIPTS_URL="$SCRIPTS_BASE"; export COMMUNITY_SCRIPTS_CORE_URL="$CORE_BASE"; bash -c "$(curl -fsSL "${COMMUNITY_SCRIPTS_URL}/${SCRIPT}")"`.

### 4.2. Прецеденты

- DevScripts и Incus пинят свою базу второй строкой: `_CS_DEFAULT_URL="https://raw.githubusercontent.com/community-scripts/DevScripts/main"` (`DEV/AGENTS.md`, шаблон CT Script; `DEV/docs/guides/source-origin.md`). Это тот же механизм, что нужен нам: `_CS_DEFAULT_URL` читается в `core/build.func` как `_CS_DEFAULT_URL="${_CS_DEFAULT_URL:-...ProxmoxVE/main}"`, и аналогично `_CS_CORE_DEFAULT_URL`.
- `community-scripts/Incus` живёт как отдельный репозиторий скриптов на том же движке (`CORE/README.md`).
- `detect_repo_source` (`CORE/api/sysinfo.func`) предусматривает чужой owner: `*) REPO_SOURCE="external"; REPO_SLUG="$owner_repo"`. `description()` подставляет `REPO_SLUG` в ссылки GitHub/Discussions/Issues.
- Для "сторонних инсталляторов" в другом смысле (скрипт зовёт upstream `install.sh`) есть `confirm_external_installer` с `var_external_installer=yes` для unattended (`CORE/core/core.func`, тест `CORE/tests/external-installer.sh`).

Явной документации "как сторонний проект публикует свой helper-script" нет (не подтверждено как отдельный гайд). Есть только fork/branch-инструкции выше, которые технически покрывают наш случай.

### 4.3. Что надо учесть

- Телеметрия (`CORE/docs/api.md`): "Telemetry is opt-out through `/usr/local/community-scripts/diagnostics`. `TELEMETRY_URL` overrides the endpoint on the host and in the container." Событие "install" уходит с `REPO_SOURCE=external` и нашим slug. Если не хотим слать, выставляем `DIAGNOSTICS=no` / свой `TELEMETRY_URL` перед `start` (точный эффект на меню `diagnostics_check` не проверялся, не подтверждено).
- `runtime_script_status_guard` на хосте и в контейнере стучится в `https://db.community-scripts.org/api/collections/script_scripts/records?filter=(slug='<slug>')` с таймаутом 2/3 c; для неизвестного slug `items: []` → `return 0`. `check_breaking_change_guard` аналогично "fails open on any error" (`CORE/docs/updates.md`).
- `header_info` без сгенерированного баннера печатает fallback: `echo "${_CS_FALLBACK_HEADER:-Community Scripts}"; echo "  ${APP:-}"` (`CORE/core/core.func`). Баннеры генерируются только для ProxmoxVE/DevScripts/Incus (`CORE/docs/headers.md`).
- Лицензии: `PVE/LICENSE` MIT "Copyright (c) 2021-2026 tteck | community-scripts ORG"; `CORE/LICENSE` MIT "Copyright (c) 2026 Proxmox Helper Scripts (CE)". `PVE/README.md`: "MIT - free to use, modify and redistribute, for personal and commercial purposes." Требование: сохранить copyright notice.
- Торговая марка: `PVE/README.md`: "This is an independent community project. Proxmox® is a registered trademark of Proxmox Server Solutions GmbH." Наш инсталлятор не должен называться "Proxmox ..." как официальный продукт.
- Критерии приёма в DevScripts, если захотим попасть в официальный каталог (`DEV/AGENTS.md`, Tips п.6): "600+ stars, 6+ months old, actively maintained, and official release tarballs published", Docker-only приложения не принимаются.

---

## 5. LXC vs VM для нашей нагрузки

### 5.1. Что говорит community-scripts

- Все приложения ставятся bare-metal в LXC: `DEV/AGENTS.md` "We do NOT use Docker for our installation scripts. All applications are installed directly on the system." Исключение только для `tools/addon/*.sh`.
- Запуск от root в контейнере считается нормой: п.9 "LXC containers run as root, no separate user needed", п.31 "the container is the isolation boundary; run as root".
- Дефолт unprivileged: в шаблоне `var_unprivileged="${var_unprivileged:-1}"`, все проверенные Node-скрипты (n8n, uptime-kuma, homarr, actualbudget, node-red, zigbee2mqtt) так и делают.
- Типичные ресурсы Node-приложений в `ct/*.sh`: n8n 2 CPU / 2048 MB / 10 GB; uptime-kuma 1 / 1024 / 4; actualbudget 2 / 2048 / 4; homarr (из `PVE/ct/homarr.sh`, не цитировался) аналогично 2 / 2048. Глобальные дефолты движка 1 / 1024 / 4 (`CORE/ui/defaults.func`).
- `CORE/README.md` ("Requirements"): "Proxmox VE 8.0 - 8.4, or 9.0 - 9.2; Root shell on the Proxmox host; Internet access during installation."
- VM-путь для приложений (`pve/vm-app.func`) существует как альтернатива "deploying applications that are normally installed in LXC containers into full Virtual Machines instead", но без встроенного `update`. Явной рекомендации "когда выбирать VM" в docs core/ProxmoxVE нет (не подтверждено).

### 5.2. Что говорит документация Proxmox (pve-docs, chapter-pct)

- "Unprivileged containers use a new kernel feature called user namespaces ... This is the default option when creating a new container."
- Privileged: "The LXC team considers this kind of container as unsafe, and they will not consider new container escape exploits to be security issues ... That's why privileged containers should only be used in trusted environments."
- "In general, full virtual machines provide better isolation. This should be considered if containers are provided to unknown or untrusted people."
- "for use cases demanding maximum isolation and the ability to live-migrate, nesting containers inside a Proxmox QEMU VM remains a recommended practice."
- features: nesting "Allow nesting. Best used with unprivileged containers with additional id mapping. Note that this will expose procfs and sysfs contents of the host to the guest. This is also required by systemd to isolate services."; keyctl "For unprivileged containers only: Allow the use of the keyctl() system call. This is required to use docker inside a container. ... Essentially, you can choose between running systemd-networkd or docker."; fuse "Allow using fuse file systems in a container. Note that interactions between fuse and the freezer cgroup can potentially cause I/O deadlocks."; mknod "experimental", mount "can have negative effects on the container's security".
- pct: "--unprivileged ... For creation, the default is 1", "--memory ... default is 512", "--swap ... default is 512", "--cores ... A container can use all available cores by default."

Источники: `https://pve.proxmox.com/pve-docs/chapter-pct.html`, `https://pve.proxmox.com/pve-docs/pct.1.html`.

### 5.3. Ограничения unprivileged LXC, релевантные auto-dev

| Аспект | Что происходит | Источник |
| --- | --- | --- |
| nesting | движок всегда ставит `nesting=1` (нужно systemd); доступ к procfs/sysfs хоста read-only | `CORE/pve/backend.func`, pve-docs |
| keyctl | для unprivileged движок всегда `keyctl=1`; Node/git/gh это не нужно, но не мешает | `CORE/pve/backend.func` |
| fuse | только по `var_fuse=yes`; нам не нужен | `CORE/ui/defaults.func` |
| Память, видимая процессам | `/proc/meminfo` через lxcfs отражает лимит CT; `setup_nodejs` считает `--max-old-space-size` = 75% MemTotal (clamp 1024..12288 MB) и экспортирует в `NODE_OPTIONS` на время установки. Для сервиса это не наследуется автоматически (это env процесса установки), в unit надо задать свой `Environment=NODE_OPTIONS=...` при необходимости | `CORE/lib/runtime.func` |
| cgroup `memory.max` | внутри CT читается как `max` ("Proxmox sets a CT's memory limit one cgroup above the CT's cgroup root"); критично для JVM, для Node не критично, так как `uv_get_constrained_memory` читает cgroup, а Node берёт heap-лимит из флага | `CORE/docs/lib.md` |
| Много дочерних процессов | ограничений на fork/pids в движке нет; `pct` опций на pids-лимит не выставляется; `maxkeys_check` на хосте следит только за kernel keys при создании контейнеров | `CORE/ui/build-ui.func` |
| Docker в LXC | не требуется нам; для справки `setup_docker` с `DOCKER_LXCFS_VISIBILITY` описан в `CORE/docs/lib.md` | |
| Обновления | `check_container_resources` при апдейте требует не меньше `var_cpu`/`var_ram`, иначе спрашивает или прерывает (exit 113) | `CORE/ui/menu.func` |

Вывод: unprivileged LXC Debian 13 с `nesting=1,keyctl=1` (дефолт движка) покрывает Node 22 + git + gh + Claude Code CLI. VM оправдана только если потребуется более сильная изоляция от хоста (например, недоверенные репозитории продуктов) или live-migration.

---

## 6. Node.js helper и systemd-юнит

### 6.1. `setup_nodejs` (`CORE/lib/runtime.func`)

```bash
setup_nodejs() {
  local NODE_VERSION="${NODE_VERSION:-24}"
  local NODE_MODULE="${NODE_MODULE:-}"
  local NODE_COREPACK_ENABLE="${NODE_COREPACK_ENABLE:-1}"
  ...
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  cleanup_legacy_install "nodejs"
  CURRENT_NODE_VERSION=$(is_tool_installed "nodejs" 2>/dev/null) || true
  ...
  # Scenario 1: Already installed at target version - upgrade to latest minor/patch
  if [[ -n "$CURRENT_NODE_VERSION" && "$CURRENT_NODE_VERSION" == "$NODE_VERSION" ]]; then
    msg_info "Update Node.js $NODE_VERSION"
    download_gpg_key "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" "/etc/apt/keyrings/nodesource.gpg" "dearmor" || ...
    $STD apt install -y --only-upgrade nodejs 2>/dev/null || true
    ...
    cache_installed_version "nodejs" "$NODE_VERSION"
  else
    # Scenario 2: Different version installed - clean upgrade
    ...
    $STD apt purge -y nodejs nodejs-doc libnode* node-* 2>/dev/null || true
    prepare_repository_setup "nodesource" || ...
    manage_tool_repository "nodejs" "$NODE_VERSION" "https://deb.nodesource.com/node_${NODE_VERSION}.x" "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" || ...
    install_packages_with_retry "nodejs" || ...
    cache_installed_version "nodejs" "$NODE_VERSION"
  fi
  ...
  # npm 11+ skips install hooks not covered by allowScripts and still exits 0
  if [[ "$npm_major" -ge 11 ]]; then
    $STD npm config set dangerously-allow-all-scripts true --location="$npm_location" 2>/dev/null || true
  fi
  ...
  export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=${node_heap_mb}"
  # Install global Node modules (NODE_MODULE="pnpm@^10,yarn,corepack" ...)
```

Пин: только major (`NODE_VERSION="22"`), репозиторий NodeSource `node_22.x`, minor/patch всегда последний. Запись версии: `cache_installed_version` → `/var/cache/app-versions/nodejs_version.txt` (`CORE/lib/system.func`). `is_tool_installed nodejs` читает `node -v`. Дефолт `NODE_VERSION` в движке 24; в ProxmoxVE есть еженедельный workflow `check-node-versions.yml` ("Check Node.js Version Drift"), который сравнивает `NODE_VERSION` в install-скриптах с upstream `engines.node` (`PVE/.github/workflows/check-node-versions.yml`).

`DEV/AGENTS.md`: "`package.json` ... the `engines` field gives the required Node major for `NODE_VERSION`; `scripts.build` gives the build command; `packageManager` says npm vs pnpm vs yarn." Пример динамического пина из `PVE/install/homarr-install.sh`:

```bash
NODE_VERSION=$(curl -s https://raw.githubusercontent.com/homarr-labs/homarr/dev/package.json | jq -r '.engines.node | split(">=")[1] | split(".")[0]')
setup_nodejs
```

и из `PVE/install/zigbee2mqtt-install.sh`:

```bash
NODE_VERSION="24" NODE_MODULE="pnpm@$(curl -fsSL https://raw.githubusercontent.com/Koenkk/zigbee2mqtt/master/package.json | jq -r '.packageManager | split("@")[1]')" setup_nodejs
```

### 6.2. systemd-юниты из реальных Node-скриптов

`PVE/install/uptimekuma-install.sh`:

```bash
msg_info "Creating Service"
ln -s /usr/bin/chromium /opt/uptime-kuma/chromium
cat <<EOF >/etc/systemd/system/uptime-kuma.service
[Unit]
Description=uptime-kuma

[Service]
Type=simple
Restart=always
User=root
WorkingDirectory=/opt/uptime-kuma
ExecStart=/usr/bin/npm start

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now uptime-kuma
msg_ok "Created Service"
```

`PVE/install/n8n-install.sh` (глобальный npm-пакет + EnvironmentFile):

```bash
cat <<EOF >/opt/n8n.env
N8N_SECURE_COOKIE=false
N8N_PORT=5678
N8N_PROTOCOL=http
N8N_HOST=${LOCAL_IP}
EOF

cat <<EOF >/etc/systemd/system/n8n.service
[Unit]
Description=n8n

[Service]
Type=simple
EnvironmentFile=/opt/n8n.env
ExecStart=n8n start

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now n8n
```

`PVE/install/zigbee2mqtt-install.sh` (pnpm):

```bash
cat <<EOF >/etc/systemd/system/zigbee2mqtt.service
[Unit]
Description=zigbee2mqtt
After=network.target

[Service]
Environment=NODE_ENV=production
ExecStart=/usr/bin/pnpm start
WorkingDirectory=/opt/zigbee2mqtt
StandardOutput=inherit
StandardError=inherit
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF
```

Эталонный паттерн из `DEV/AGENTS.md` ("Systemd Service Pattern"):

```bash
msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/appname.service
[Unit]
Description=AppName Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/appname
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/appname/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now appname
msg_ok "Created Service"
```

Правила вокруг (`DEV/AGENTS.md`): новый юнит не требует `systemctl daemon-reload` (п.13); `.env` без `export` (п.10); пароли через `random_password` (п.33); `apt`, не `apt-get` (п.22); `$STD` перед apt/npm/build (п.7); helper-функции с собственными сообщениями (`setup_nodejs`, `fetch_and_deploy_gh_release`, `check_for_gh_release`, `create_backup`, `restore_backup`) не оборачивать в `msg_info`/`msg_ok` (п.8); в CT-скрипте только одна функция `update_script()` (п.5, 28); `exit` в конце `update_script` обязателен, `return` пустит выполнение дальше в `run_addon_updates` (сайт ct/detailed_guide, AGENTS.md "IMPORTANT: Always end with exit!").

---

## Источники

Core (`7a1a54458c1da30b3e3c52596a7ae9a09702a3e9`):

- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/README.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/LICENSE
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/README.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/loading.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/core.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/lxc.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/updates.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/backends.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/lib.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/vm.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/ui.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/api.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/headers.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/docs/contributing.md
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/core/build.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/core/core.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/core/error_handler.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/ui/build-ui.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/ui/defaults.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/ui/menu.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/pve/backend.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/pve/vm-app.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/lxc/install.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/lib/forge.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/lib/runtime.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/lib/system.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/api/sysinfo.func
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/misc/update.sh
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/tools/run.sh
- https://github.com/community-scripts/core/blob/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9/tests/external-installer.sh

ProxmoxVE (`06b788ee81175f42b0256d66725331b0c3d9643c`):

- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/README.md
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/CONTRIBUTING.md
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/LICENSE
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/ct/n8n.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/install/n8n-install.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/ct/uptimekuma.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/install/uptimekuma-install.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/ct/actualbudget.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/install/homarr-install.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/install/zigbee2mqtt-install.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/install/node-red-install.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/ct/debian.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/vm/debian-vm.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/tools/pve/update-apps.sh
- https://github.com/community-scripts/ProxmoxVE/blob/06b788ee81175f42b0256d66725331b0c3d9643c/.github/workflows/check-node-versions.yml

DevScripts (`ad794584d20af1e5779a34342ef0511707202034`):

- https://github.com/community-scripts/DevScripts/blob/ad794584d20af1e5779a34342ef0511707202034/AGENTS.md
- https://github.com/community-scripts/DevScripts/blob/ad794584d20af1e5779a34342ef0511707202034/docs/README.md
- https://github.com/community-scripts/DevScripts/blob/ad794584d20af1e5779a34342ef0511707202034/docs/guides/source-origin.md
- https://github.com/community-scripts/DevScripts/blob/ad794584d20af1e5779a34342ef0511707202034/json/aiostreams.json

Сайт и Proxmox:

- https://community-scripts.org/docs (индекс), https://community-scripts.org/docs/ct/readme, https://community-scripts.org/docs/ct/detailed_guide, https://community-scripts.org/docs/install/readme, https://community-scripts.org/docs/install/detailed_guide, https://community-scripts.org/docs/vm/readme, https://community-scripts.org/docs/contribution/readme (страницы сайта читались через fetch и пересказаны, дословные цитаты только там, где помечены кавычками)
- https://pve.proxmox.com/pve-docs/chapter-pct.html
- https://pve.proxmox.com/pve-docs/pct.1.html
