#!/usr/bin/env bash
# Prints the next release version (X.Y.Z, without `v`) from the Conventional Commits since the last release tag:
# a breaking change (`type!:` or a `BREAKING CHANGE:` footer) bumps major, `feat` bumps minor, `fix` and `perf`
# bump patch, every other type releases nothing. Prints nothing when no commit calls for a release.
# Pre-release tags (v1.2.0-rc1) are never the base; with no release tag at all the base is 0.0.0.
#
#   scripts/next-version.sh [--notes]
#
# --notes prints the Markdown release notes for the same commits instead of the version.
set -euo pipefail

notes=0
while (($# > 0)); do
  case "$1" in
  --notes)
    notes=1
    shift
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 64
    ;;
  esac
done

last="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude 'v*-*' 2>/dev/null || true)"
if [[ -n "$last" ]]; then
  range="$last..HEAD"
  base="${last#v}"
else
  range="HEAD"
  base="0.0.0"
fi

pattern='^([a-z]+)(\([^)]*\))?(!)?: (.+)$'
bump=0 # 0 none, 1 patch, 2 minor, 3 major
breaking=()
features=()
fixes=()
while IFS= read -r -d $'\x1e' commit; do
  commit="${commit#$'\n'}"
  sha="${commit%%$'\x1f'*}"
  rest="${commit#*$'\x1f'}"
  subject="${rest%%$'\x1f'*}"
  body="${rest#*$'\x1f'}"
  [[ "$subject" =~ $pattern ]] || continue
  type="${BASH_REMATCH[1]}"
  line="- ${BASH_REMATCH[4]} (${sha})"
  if [[ -n "${BASH_REMATCH[3]}" ]] || grep -qE '^BREAKING[ -]CHANGE:' <<<"$body"; then
    level=3
    breaking+=("$line")
  elif [[ "$type" == feat ]]; then
    level=2
    features+=("$line")
  elif [[ "$type" == fix || "$type" == perf ]]; then
    level=1
    fixes+=("$line")
  else
    level=0
  fi
  if ((level > bump)); then bump=$level; fi
done < <(git log --no-merges --format='%h%x1f%s%x1f%b%x1e' "$range")

((bump > 0)) || exit 0

if ((notes)); then
  section() {
    local title="$1"
    shift
    (($# > 0)) || return 0
    printf '### %s\n\n' "$title"
    printf '%s\n' "$@"
    printf '\n'
  }
  section "Breaking changes" ${breaking[@]+"${breaking[@]}"}
  section "Features" ${features[@]+"${features[@]}"}
  section "Fixes" ${fixes[@]+"${fixes[@]}"}
  exit 0
fi

IFS=. read -r major minor patch <<<"$base"
case "$bump" in
1) patch=$((patch + 1)) ;;
2)
  minor=$((minor + 1))
  patch=0
  ;;
3)
  major=$((major + 1))
  minor=0
  patch=0
  ;;
esac
echo "$major.$minor.$patch"
