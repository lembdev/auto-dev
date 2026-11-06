#!/usr/bin/env bash
_CS_DEFAULT_URL="${_CS_DEFAULT_URL:-https://raw.githubusercontent.com/lembdev/auto-dev/main}"
_CS_CORE_DEFAULT_URL="${_CS_CORE_DEFAULT_URL:-https://raw.githubusercontent.com/community-scripts/core/7a1a54458c1da30b3e3c52596a7ae9a09702a3e9}"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
# shellcheck disable=SC1090
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-$_CS_CORE_DEFAULT_URL}/core/build.func")
# Source: https://github.com/lembdev/auto-dev
# Engine: community-scripts/core (MIT, Copyright (c) 2026 Proxmox Helper Scripts (CE)), pinned above.
#
# On a Proxmox VE host this creates the LXC and runs install/auto-dev-install.sh inside it.
# Inside the container (via `update`) the engine calls update_script instead.

APP="auto-dev"
var_tags="${var_tags:-dev-tools;ai}"
var_cpu="${var_cpu:-4}"
var_ram="${var_ram:-8192}"
var_disk="${var_disk:-40}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"
var_arm64="${var_arm64:-yes}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -d /opt/auto-dev/releases ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  NODE_VERSION="22" setup_nodejs
  fetch_and_deploy_gh_release "gh" "cli/cli" "binary"

  if check_for_gh_release "auto-dev" "lembdev/auto-dev"; then
    msg_info "Stopping Service"
    systemctl stop auto-dev
    msg_ok "Stopped Service"

    # Each release lands in its own directory; `current` flips to it, the previous one stays for a rollback.
    staging="$(mktemp -d /opt/auto-dev/.deploy.XXXXXX)"
    fetch_and_deploy_gh_release "auto-dev" "lembdev/auto-dev" "prebuild" "latest" "$staging" "auto-dev-*.tar.gz"
    version="$(jq -r .version "$staging/package.json")"

    msg_info "Switching to auto-dev ${version}"
    rm -rf "/opt/auto-dev/releases/${version}"
    mv "$staging" "/opt/auto-dev/releases/${version}"
    chown -R root:root "/opt/auto-dev/releases/${version}"
    chmod -R u+rwX,go+rX,go-w "/opt/auto-dev/releases/${version}"
    ln -sfn "releases/${version}" /opt/auto-dev/current
    install -m 0644 /opt/auto-dev/current/deploy/auto-dev.service /etc/systemd/system/auto-dev.service
    install -m 0440 /opt/auto-dev/current/deploy/auto-dev.sudoers /etc/sudoers.d/auto-dev
    visudo -cf /etc/sudoers.d/auto-dev >/dev/null
    systemctl daemon-reload
    msg_ok "Switched to auto-dev ${version}"

    msg_info "Starting Service"
    systemctl start auto-dev
    msg_ok "Started Service"
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Open the first-run wizard using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:8080${CL}"
