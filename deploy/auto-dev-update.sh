#!/usr/bin/env bash
# Update and rollback of an auto-dev Installation, run as root inside the container.
#
#   auto-dev-update.sh install <release-dir>   the new release unpacked by update_script() of ct/auto-dev.sh
#   auto-dev-update.sh rollback                back to the release that was current before the last update
#
# Order of an update: Pause and the running Turns finished (interrupted after 10 minutes) -> stop ->
# the release into releases/<version> -> migrations forward -> `current` flipped -> start. The new
# version lifts the Pause and resumes the interrupted Turns on its own start. The runtime index and
# the env file live outside the releases and are never touched here.
set -euo pipefail

ROOT="${AUTO_DEV_ROOT:-/opt/auto-dev}"
SERVICE="${AUTO_DEV_SERVICE:-auto-dev}"
APP_USER="${AUTO_DEV_USER:-auto-dev}"
UNIT_FILE="${AUTO_DEV_UNIT_FILE:-/etc/systemd/system/auto-dev.service}"
SUDOERS_FILE="${AUTO_DEV_SUDOERS_FILE:-/etc/sudoers.d/auto-dev}"
UPDATE_WRAPPER="${AUTO_DEV_UPDATE_WRAPPER:-/usr/local/bin/update}"
# Where the community-scripts engine keeps the installed version; a rollback writes the version it went back to.
VERSION_STAMP="${AUTO_DEV_VERSION_STAMP:-${HOME:-/root}/.auto-dev}"
# The service reads these from its unit; the helpers of main.js need the same ones.
export AUTO_DEV_ENV_FILE="${AUTO_DEV_ENV_FILE:-/etc/auto-dev/env}"
export AUTO_DEV_DATA_DIR="${AUTO_DEV_DATA_DIR:-/var/lib/auto-dev}"

# Exit codes of `node dist/main.js <command>`, see src/cli.ts.
EXIT_UNREACHABLE=2
EXIT_SCHEMA_TOO_NEW=3

say() { echo "auto-dev update: $*"; }
die() {
  echo "auto-dev update: $*" >&2
  exit 1
}

is_root() { [[ "$(id -u)" -eq 0 ]]; }

# The helpers run as the service user, so files they create in the data dir stay its own.
as_app() {
  if is_root; then
    runuser -u "$APP_USER" -- "$@"
  else
    "$@"
  fi
}

# A release that ships the updater commands; older ones would start a second service on `main.js <command>`.
has_cli() { [[ -f "$1/dist/cli.js" ]]; }

release_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -n 1
}

# Absolute directory a link under ROOT points at; empty when the link is missing or dangling.
resolve_link() {
  local link="$ROOT/$1" target
  [[ -L "$link" ]] || return 0
  target="$(readlink "$link")"
  [[ "$target" == /* ]] || target="$ROOT/$target"
  [[ -d "$target" ]] && (cd "$target" && pwd -P)
  return 0
}

point() {
  local name="$1" dir="$2"
  ln -sfn "releases/$(basename "$dir")" "$ROOT/$name"
}

# Pause with the update source and wait for the Turns; whatever happens, the update goes on afterwards:
# Turns still running at the stop are remembered by the service and resumed after the start.
prepare_service() {
  local current="$1" code=0
  if ! systemctl is-active --quiet "$SERVICE"; then
    say "service is not running, nothing to prepare"
    return 0
  fi
  if [[ -z "$current" ]] || ! has_cli "$current"; then
    say "the running release cannot prepare for an update, stopping it as is"
    return 0
  fi
  say "pausing the Installation and waiting for the running turns (up to 10 minutes)"
  as_app node "$current/dist/main.js" prepare-update || code=$?
  case "$code" in
    0) ;;
    "$EXIT_UNREACHABLE") say "the service did not answer, stopping it as is" ;;
    *) say "the preparation failed (exit $code), stopping the service anyway" ;;
  esac
}

install_system_files() {
  local release="$1" sudoers_tmp
  install -m 0644 "$release/deploy/auto-dev.service" "$UNIT_FILE"
  # A broken sudoers file locks root out of sudo: checked before it replaces the working one.
  sudoers_tmp="$(mktemp "$(dirname "$SUDOERS_FILE")/.auto-dev.XXXXXX")"
  install -m 0440 "$release/deploy/auto-dev.sudoers" "$sudoers_tmp"
  if visudo -cf "$sudoers_tmp" >/dev/null; then
    mv -f "$sudoers_tmp" "$SUDOERS_FILE"
  else
    rm -f "$sudoers_tmp"
    say "sudoers of $(basename "$release") does not pass visudo, keeping the installed one"
  fi
  install -m 0755 "$release/deploy/update" "$UPDATE_WRAPPER"
  systemctl daemon-reload
}

cmd_install() {
  local staging="${1:-}" version target current
  [[ -n "$staging" && -f "$staging/package.json" && -f "$staging/dist/main.js" ]] || die "not a release directory: ${staging:-<none>}"
  version="$(release_version "$staging")"
  [[ -n "$version" ]] || die "no version in $staging/package.json"
  mkdir -p "$ROOT/releases"
  target="$(cd "$ROOT/releases" && pwd -P)/$version"
  current="$(resolve_link current)"

  prepare_service "$current"
  say "stopping the service"
  systemctl stop "$SERVICE"

  if [[ "$(cd "$staging" && pwd -P)" != "$target" ]]; then
    rm -rf "$target"
    mv "$staging" "$target"
  fi
  if is_root; then chown -R root:root "$target"; fi
  chmod -R u+rwX,go+rX,go-w "$target"

  say "migrating the runtime index forward"
  local code=0
  as_app node "$target/dist/main.js" migrate || code=$?
  if [[ "$code" -ne 0 ]]; then
    if [[ -n "$current" ]]; then
      say "starting $(basename "$current") again"
      systemctl start "$SERVICE"
    fi
    if [[ "$code" -eq "$EXIT_SCHEMA_TOO_NEW" ]]; then
      die "the runtime index is newer than $version: an update must not go backwards; staying on $(basename "${current:-none}")"
    fi
    die "migrations of $version failed (exit $code); staying on $(basename "${current:-none}")"
  fi

  point current "$target"
  if [[ -n "$current" && "$current" != "$target" ]]; then point previous "$current"; fi
  install_system_files "$target"
  say "starting $version"
  systemctl start "$SERVICE"
  say "updated to $version"
}

cmd_rollback() {
  local current previous db_schema wanted
  current="$(resolve_link current)"
  previous="$(resolve_link previous)"
  [[ -n "$current" ]] || die "no current release under $ROOT"
  [[ -n "$previous" && "$previous" != "$current" ]] || die "no previous release to roll back to"
  has_cli "$previous" || die "$(basename "$previous") predates rollback support and cannot report its schema version"

  db_schema="$(as_app node "$current/dist/main.js" schema-version --db)"
  wanted="$(as_app node "$previous/dist/main.js" schema-version)"
  if [[ "$db_schema" != "$wanted" ]]; then
    die "cannot roll back to $(basename "$previous"): it expects runtime index schema $wanted, the index is at $db_schema. Migrations only go forward, so this rollback would need a downgrade of the index; update to a newer release instead."
  fi

  prepare_service "$current"
  say "stopping the service"
  systemctl stop "$SERVICE"
  point current "$previous"
  point previous "$current"
  install_system_files "$previous"
  release_version "$previous" >"$VERSION_STAMP"
  say "starting $(basename "$previous")"
  systemctl start "$SERVICE"
  say "rolled back to $(basename "$previous")"
}

case "${1:-}" in
  install) cmd_install "${2:-}" ;;
  rollback) cmd_rollback ;;
  *) die "usage: $(basename "$0") install <release-dir> | rollback" ;;
esac
