#!/usr/bin/env bash
# Packs a built checkout into auto-dev-<version>.tar.gz: dist/, prompts/, deploy/, the manifests and
# production node_modules. The archive is what the GitHub Release carries and what the installer unpacks.
#
#   scripts/package-release.sh [--root DIR] [--out DIR]
#
# Prints the archive path as its last line.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out=""
while (($# > 0)); do
  case "$1" in
  --root)
    root="$(cd "$2" && pwd)"
    shift 2
    ;;
  --out)
    out="$2"
    shift 2
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 64
    ;;
  esac
done
out="${out:-$root/release}"

for required in dist/main.js dist/client/index.html prompts package.json package-lock.json deploy; do
  if [[ ! -e "$root/$required" ]]; then
    echo "missing $root/$required: run \`npm run build\` first" >&2
    exit 1
  fi
done

version="$(node -p "require('$root/package.json').version")"
name="auto-dev-${version}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name" "$out"

cp -R "$root/dist" "$root/prompts" "$root/deploy" "$stage/$name/"
cp "$root/package.json" "$root/package-lock.json" "$stage/$name/"
[[ -f "$root/README.md" ]] && cp "$root/README.md" "$stage/$name/"

# Production dependencies only, from the lockfile, and the same tree on any build host: argon2 ships its
# linux x64 and arm64 prebuilds inside the package, and the Agent SDK's optional per-platform claude binaries
# stay out because the Installation runs the system claude through pathToClaudeCodeExecutable.
(cd "$stage/$name" && npm ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error)

archive="$out/$name.tar.gz"
# COPYFILE_DISABLE keeps macOS from adding ._* resource forks to the archive.
COPYFILE_DISABLE=1 tar -C "$stage" -czf "$archive" "$name"
echo "$archive"
