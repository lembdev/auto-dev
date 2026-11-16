#!/usr/bin/env bash
# Seeds lembdev/auto-dev-sandbox with a fresh batch of work for the Orchestrator: a milestone, an Epic
# and three Tasks with `ready-for-agent`. One Task is blocked by another, one asks the human a question.
# Every run takes the next theme that has no milestone yet; once all are used, themes repeat with a
# run number in the title and in the module file, so the batches never collide.
#
#   scripts/sandbox-seed.sh             # create the batch
#   scripts/sandbox-seed.sh --dry-run   # print what would be created
set -euo pipefail

REPO="lembdev/auto-dev-sandbox"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n | --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Theme: key|epic title|module|task A|task B (blocked by A)|task C (asks the human)
# Task: function|description
THEMES=(
  "date|Утилиты для дат|date|addDays|Функция addDays(date, n): новая дата Date, сдвинутая на n дней (n может быть отрицательным), исходная не меняется.|diffInDays|Функция diffInDays(a, b): целое число дней между датами, использует addDays в тестах для построения входных данных.|formatDate|Функция formatDate(date). Формат не задан: перед реализацией спроси человека через ask_human, варианты: DD.MM.YYYY, YYYY-MM-DD."
  "object|Утилиты для объектов|object|pick|Функция pick(obj, keys): новый объект только с перечисленными ключами, отсутствующие ключи пропускаются.|omit|Функция omit(obj, keys): новый объект без перечисленных ключей; реализовать через pick.|deepMerge|Функция deepMerge(a, b): глубокое слияние объектов. Поведение для массивов не задано: перед реализацией спроси человека через ask_human, варианты: заменять, склеивать."
  "case|Преобразование регистра|case|camelCase|Функция camelCase(text): 'hello world-foo' -> 'helloWorldFoo'. Разделители: пробел, дефис, подчёркивание.|snakeCase|Функция snakeCase(text): 'helloWorld foo' -> 'hello_world_foo'; разбиение на слова общее с camelCase, вынести в отдельную функцию words.|titleCase|Функция titleCase(text). Неясно, что делать с короткими словами (and, of, the): перед реализацией спроси человека через ask_human, варианты: всегда с заглавной, оставлять строчными."
  "validate|Валидаторы|validate|isEmail|Функция isEmail(text): простая проверка вида local@domain.tld без внешних библиотек.|isUrl|Функция isUrl(text): true для http(s) URL; использовать URL из стандартной библиотеки.|isStrongPassword|Функция isStrongPassword(text). Минимальная длина не задана: перед реализацией спроси человека через ask_human, варианты: 8, 12."
  "color|Работа с цветом|color|hexToRgb|Функция hexToRgb(hex): '#ff8800' и '#f80' -> { r, g, b }; некорректный ввод бросает ошибку.|rgbToHex|Функция rgbToHex({ r, g, b }): обратное к hexToRgb, в тестах проверить круговое преобразование.|lighten|Функция lighten(hex, amount). Единица amount не задана: перед реализацией спроси человека через ask_human, варианты: проценты 0-100, доля 0-1."
  "collection|Утилиты для коллекций|collection|groupBy|Функция groupBy(items, keyFn): объект { ключ: массив элементов } в исходном порядке.|countBy|Функция countBy(items, keyFn): объект { ключ: количество }; реализовать через groupBy.|sortBy|Функция sortBy(items, keyFn), сортировка устойчивая, исходный массив не меняется. Порядок по умолчанию не задан: перед реализацией спроси человека через ask_human, варианты: по возрастанию, по убыванию."
)

need() { command -v "$1" >/dev/null || { echo "нужен $1" >&2; exit 1; }; }
need gh
need jq

milestones_json=$(gh api --paginate "repos/$REPO/milestones?state=all&per_page=100" | jq -s 'add // []')
existing_titles=$(jq -r '.[].title' <<<"$milestones_json")
epic_index=$(( $(jq 'length' <<<"$milestones_json") + 1 ))

# True when some milestone title ends with the given text.
taken() {
  local line
  while IFS= read -r line; do
    [[ "$line" == *"$1" ]] && return 0
  done <<<"$existing_titles"
  return 1
}

# The first theme without a milestone; when all are taken, the themes repeat with a round number.
choice=""
round=1
while [[ -z "$choice" ]]; do
  for theme in "${THEMES[@]}"; do
    IFS='|' read -r _ title _ <<<"$theme"
    suffix=""; [[ $round -gt 1 ]] && suffix=" ($round)"
    if ! taken ": $title$suffix"; then choice="$theme"; break; fi
  done
  [[ -z "$choice" ]] && round=$((round + 1))
done

IFS='|' read -r _ title module a_fn a_desc b_fn b_desc c_fn c_desc <<<"$choice"
suffix=""; file_suffix=""
if [[ $round -gt 1 ]]; then suffix=" ($round)"; file_suffix="$round"; fi
milestone="Эпик $epic_index: $title$suffix"
file="src/$module$file_suffix.js"
test_file="test/$module$file_suffix.test.js"
where="Код в $file, тесты в $test_file (node:test). Запуск: npm test."

echo "Репозиторий: $REPO"
echo "Веха:        $milestone"
echo "Модуль:      $file"
if [[ $DRY_RUN -eq 1 ]]; then
  printf '  Epic\n  %s\n  %s (blocked by %s)\n  %s (ask_human)\n' "$a_fn" "$b_fn" "$a_fn" "$c_fn"
  exit 0
fi

for label in ready-for-agent ready-for-human; do
  gh label create "$label" -R "$REPO" >/dev/null 2>&1 || true
done

gh api "repos/$REPO/milestones" -f title="$milestone" >/dev/null

number_of() { basename "$1"; }

epic_url=$(gh issue create -R "$REPO" --milestone "$milestone" \
  --title "Epic: $title$suffix" \
  --body "Модуль \`$file\`.

Критерии закрытия:

- [ ] Есть $a_fn с тестами
- [ ] Есть $b_fn с тестами
- [ ] Есть $c_fn с тестами")
epic=$(number_of "$epic_url")

a_url=$(gh issue create -R "$REPO" --milestone "$milestone" --parent "$epic" --label ready-for-agent \
  --title "Добавить $a_fn в $file" --body "$a_desc

$where")
a=$(number_of "$a_url")

b_url=$(gh issue create -R "$REPO" --milestone "$milestone" --parent "$epic" --label ready-for-agent --blocked-by "$a" \
  --title "Добавить $b_fn в $file" --body "$b_desc

$where")
b=$(number_of "$b_url")

c_url=$(gh issue create -R "$REPO" --milestone "$milestone" --parent "$epic" --label ready-for-agent \
  --title "Добавить $c_fn в $file" --body "$c_desc

$where")
c=$(number_of "$c_url")

echo
echo "Epic #$epic  $epic_url"
echo "  #$a  $a_fn"
echo "  #$b  $b_fn (blocked by #$a)"
echo "  #$c  $c_fn (ask_human)"
