#!/usr/bin/env bash
# Source: https://github.com/lembdev/auto-dev
# Runs as root inside the new container; the engine hands its library over in FUNCTIONS_FILE_PATH.

# shellcheck disable=SC1091
source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

APP_USER="auto-dev"
APP_HOME="/home/auto-dev"

msg_info "Installing Dependencies"
$STD apt install -y git sudo jq ca-certificates
msg_ok "Installed Dependencies"

fetch_and_deploy_gh_release "gh" "cli/cli" "binary"
NODE_VERSION="22" setup_nodejs

msg_info "Creating User ${APP_USER}"
# A regular user with a home: the native claude installs there and the Agents run under it.
id -u "$APP_USER" &>/dev/null || useradd --create-home --home-dir "$APP_HOME" --shell /bin/bash "$APP_USER"
# Reading `journalctl -u auto-dev` for the UI log page needs the journal group, no sudo.
usermod -aG systemd-journal "$APP_USER"
# The wizard writes the env file into /etc/auto-dev itself (tmp + rename), so the directory belongs to the user.
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 /etc/auto-dev /var/lib/auto-dev
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 /var/lib/auto-dev/claude
install -d -m 0755 /opt/auto-dev /opt/auto-dev/releases
msg_ok "Created User ${APP_USER}"

msg_info "Installing Claude Code for ${APP_USER} (native installer, auto-updates itself)"
$STD runuser -l "$APP_USER" -c 'curl -fsSL https://claude.ai/install.sh | bash'
msg_ok "Installed Claude Code"

# Each release lands in its own directory; `current` points at the one the service runs.
staging="$(mktemp -d /opt/auto-dev/.deploy.XXXXXX)"
fetch_and_deploy_gh_release "auto-dev" "lembdev/auto-dev" "prebuild" "latest" "$staging" "auto-dev-*.tar.gz"
version="$(jq -r .version "$staging/package.json")"

msg_info "Installing auto-dev ${version}"
rm -rf "/opt/auto-dev/releases/${version}"
mv "$staging" "/opt/auto-dev/releases/${version}"
chown -R root:root "/opt/auto-dev/releases/${version}"
chmod -R u+rwX,go+rX,go-w "/opt/auto-dev/releases/${version}"
ln -sfn "releases/${version}" /opt/auto-dev/current
msg_ok "Installed auto-dev ${version}"

msg_info "Creating Service"
install -m 0644 /opt/auto-dev/current/deploy/auto-dev.service /etc/systemd/system/auto-dev.service
install -m 0440 /opt/auto-dev/current/deploy/auto-dev.sudoers /etc/sudoers.d/auto-dev
visudo -cf /etc/sudoers.d/auto-dev >/dev/null
# `update --rollback`: the engine's /usr/bin/update drops arguments, this one in /usr/local/bin comes first in PATH.
install -m 0755 /opt/auto-dev/current/deploy/update /usr/local/bin/update
systemctl enable -q --now auto-dev
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
