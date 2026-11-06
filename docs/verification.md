# Проверка auto-dev перед релизом 1.0.0

Порядок: сначала проверка на своей машине против песочницы на GitHub, затем релиз-кандидат `0.9.0` на Proxmox,
затем релиз `1.0.0` через штатное обновление и проверка отката. Версия `1.0.0` выходит только если все шаги
прошли. Установщик ставит только релиз, помеченный latest, поэтому для проверки на Proxmox нужен настоящий
релиз: им служит `0.9.0`, а переход `0.9.0 -> 1.0.0` заодно проверяет обновление и откат.

Если шаг не проходит: остановиться, собрать `GET /api/tasks`, хвост журнала и состояние issue, завести баг в
`lembdev/auto-dev` с этими данными в теле.

## Продолжение после исправлений (без старта с нуля)

Первый прогон дошёл до Тупиков #2 и #4: QA три Круга подряд считал blocker'ом префикс `WIP:` в заголовке PR,
хотя его ставит и снимает Оркестратор. Исправлено, заодно ужесточены правила коммитов, лента Агента рисует
Markdown, промпт запуска свёрнут. Данные Установки (`~/auto-dev-local`) и песочница остаются как есть.

Уже пройдено: Этапы 0-2, сценарии 1 (взятие), 2 (лента), 3 (запрос к человеку и Ответ), 13 (Тупик).

### Второй прогон: Задачи висят в Merge

После перезапуска #2 и #4 прошли QA (PR #7 и #8 без `WIP:`), но не сливались: PAT получал 403 на чтение
check runs, а такого права у fine-grained PAT нет. Исправлено: CI читается через GitHub Actions, мастер
проверяет `Actions: read` и `Commit statuses: read`. Продолжить так:

1. На github.com -> Settings -> Developer settings -> Fine-grained tokens -> токен Установки -> Edit:
   Repository permissions -> Actions: Read-only -> Update. Токен остаётся прежним, вводить заново не нужно.
2. Проверить: `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <PAT>"
   https://api.github.com/repos/lembdev/auto-dev-sandbox/actions/runs` -> `200`.
3. Остановить процесс, `git pull && npm ci && npm run build`, запустить с тем же `~/auto-dev-local`.
4. Ожидается: в течение минуты PR #7 и #8 слиты squash-коммитами `feat: add slugify` и `feat: add greet`,
   issue закрыты, затем взята #3. Это сценарии 4 и 5. Бейдж Агента после QA серый «агент завершён»: это
   штатно, процесс QA закончил работу, merge делает Оркестратор без Агента.
5. Дальше Этап 3 со сценария 6.

### Первый прогон: Тупики из-за `WIP:`

1. Остановить локальный процесс (Ctrl+C в его терминале).
2. Обновить код и собрать:

   ```
   cd ~/Developer/lembdev/auto-dev
   git switch spec-1-auto-dev && git pull
   npm ci && npm run build && npm test
   ```

   Ожидается: тесты зелёные.
3. Запустить с теми же данными (мастер не повторяется):

   ```
   AUTO_DEV_DATA_DIR=$HOME/auto-dev-local AUTO_DEV_ENV_FILE=$HOME/auto-dev-local/env \
     AUTO_DEV_PORT=8080 LOG_LEVEL=info npm start
   ```

   Ожидается: открывается Режим разработки, #2 и #4 в «Тупиках», #3 в Готовых (ждёт блокер #2).
4. Запустить Задачи из Тупика заново:

   ```
   for n in 2 4; do gh issue edit $n -R lembdev/auto-dev-sandbox --remove-label ready-for-human --add-label ready-for-agent; done
   ```

   Ожидается: на ближайшем опросе обе взяты новой попыткой: ветки `worktree-issue-2-r2` и `worktree-issue-4-r2`,
   новые PR `WIP: ...`, старые PR #5 и #6 закрыты, их ветки удалены. Это заодно вторая половина сценария 13.
5. Проверить новое в UI: в карточке Агента первая строка «Промпт запуска» свёрнута и раскрывается по клику;
   текст Агента отформатирован (заголовки, списки, `код`), без сырых `**` и `#`.
6. #4 снова спросит язык: ответить из UI или комментарием в issue (сценарий 3 повторно, быстрая проверка).
7. Дальше Этап 3 со сценария 4. Формат коммитов проверять в сценарии 4.

## Итоги прогона на песочнице

Этап 3 пройден целиком: сценарии 1-16, Тупик в первом прогоне. Найдено и исправлено по ходу:

- QA считал blocker'ом префикс `WIP:` в заголовке PR.
- Fine-grained PAT не читает check runs: CI читается через Actions, PAT нужно `Actions: read`.
- Задача не бралась после закрытия блокера: GitHub не обновляет её `updated_at`.
- Ход, прерванный штатной остановкой сервера, не продолжался после рестарта: теперь Агент получает сообщение
  «продолжай».
- Лента: дубли текста, нет промпта запуска в живом потоке, «Остановить ход» выглядел как ошибка.

Открыто:

- Лимит подписки не собирается: statusline не запускается в headless-режиме SDK, поэтому «нет данных» в
  шапке, пустой график и не работает защита при 95 %. Нужен другой источник данных, решение не принято.
- Планировщик называет новую веху «Эпик 1», не видя закрытых вех с тем же номером.
- После Отмены у issue остаётся assignee.

## Этап 0. Подготовка

1. Ветка и сборка:

   ```
   cd ~/Developer/lembdev/auto-dev
   git fetch && git switch spec-1-auto-dev && git pull
   npm ci && npm run build && npm test
   ```

   Ожидается: тесты зелёные.

2. В окружении нет ключей API (иначе Установка откажется стартовать, так и задумано):

   ```
   env | grep -E 'ANTHROPIC_(API_KEY|AUTH_TOKEN)' || echo ok
   ```

3. OAuth-токен подписки Max: `claude setup-token`, сохранить выведенный токен.

## Этап 1. Песочница на GitHub

Агенты работают с полными правами пользователя, поэтому проверяем на отдельном репозитории, не на Продукте.

1. Репозиторий с минимальным проектом и контрактом трекера:

   ```
   cd ~/Developer && gh repo create lembdev/auto-dev-sandbox --private --clone && cd auto-dev-sandbox
   mkdir -p src test docs/agents
   cat > package.json <<'JSON'
   { "name": "sandbox", "private": true, "type": "module", "scripts": { "test": "node --test" } }
   JSON
   echo 'export const hello = () => "hello";' > src/index.js
   cat > test/index.test.js <<'JS'
   import { test } from "node:test"; import assert from "node:assert"; import { hello } from "../src/index.js";
   test("hello", () => assert.equal(hello(), "hello"));
   JS
   printf '# Sandbox\n\nТесты: `npm test`. Коммиты одной строкой Conventional Commits.\n' > CLAUDE.md
   cp ~/Developer/lembdev/auto-dev/docs/agents/issue-tracker.md docs/agents/
   git add -A && git commit -m "chore: init sandbox" && git push -u origin main
   ```

2. Метки, веха, Epic и Задачи:

   ```
   gh label create ready-for-agent; gh label create ready-for-human
   gh api repos/lembdev/auto-dev-sandbox/milestones -f title="Эпик 1: Строковые утилиты"
   M="Эпик 1: Строковые утилиты"
   gh issue create --milestone "$M" --title "Epic: строковые утилиты" --body $'Критерии закрытия:\n\n- [ ] Есть slugify с тестами\n- [ ] Есть truncate с тестами\n- [ ] Есть greet с тестами'
   gh issue create --milestone "$M" --parent 1 --label ready-for-agent --title "Добавить slugify" --body "Функция slugify(text) в src/index.js: нижний регистр, пробелы в дефисы, только [a-z0-9-]. Тесты в test/."
   gh issue create --milestone "$M" --parent 1 --label ready-for-agent --blocked-by 2 --title "Добавить truncate" --body "Функция truncate(text, max) в src/index.js, добавляет многоточие при обрезке. Тесты в test/."
   gh issue create --milestone "$M" --parent 1 --label ready-for-agent --title "Добавить greet" --body "Функция greet(name) в src/index.js. Язык приветствия не задан: перед реализацией спроси человека через ask_human, варианты: русский, английский. Тесты в test/."
   ```

   Ожидается: Epic #1 без `ready-for-agent`, Задачи #2, #3, #4 как его sub-issues, у #3 блокер #2.

3. Fine-grained PAT только на `lembdev/auto-dev-sandbox`: Issues RW, Pull requests RW, Contents RW,
   Actions R, Commit statuses R, Metadata R. Права «Checks» у fine-grained PAT нет: CI Оркестратор читает
   через Actions.

## Этап 2. Локальный запуск и мастер

1. Запуск с данными вне репозитория:

   ```
   mkdir -p ~/auto-dev-local
   cd ~/Developer/lembdev/auto-dev
   AUTO_DEV_DATA_DIR=$HOME/auto-dev-local AUTO_DEV_ENV_FILE=$HOME/auto-dev-local/env \
     AUTO_DEV_PORT=8080 LOG_LEVEL=info npm start
   ```

2. Открыть `http://localhost:8080` и пройти мастер: пароль -> `lembdev/auto-dev-sandbox` и PAT ->
   проверка доступа -> OAuth-токен -> smoke-query -> клон -> готово.

   Ожидается: каждый шаг зелёный; после «готово» открывается Режим разработки без рестарта.
   Проверить отказ: на шаге доступа ввести токен без прав на Pull requests, мастер не пускает дальше.
   Если smoke-query падает с «Not logged in», проверить, что введён токен из `claude setup-token`.

3. Мастер возобновляется: на середине мастера остановить процесс (Ctrl+C), запустить снова, мастер
   продолжает с недоделанного шага.

## Этап 3. Сценарии на песочнице

Отмечать по ходу. Где сказано «в GitHub», смотреть issue и PR песочницы.

1. **Взятие.** В течение 15-20 с после старта взяты #2 и #4 (Слотов 2), #3 в Готовых.
   В GitHub: assignee = владелец PAT, `ready-for-agent` снята, открыты PR `WIP: ...` с `Closes #N` и одним
   пустым коммитом `chore: start work on ...`. В UI карточки «В работе», Стадия «Реализация».
2. **Лента Агента.** Открыть карточку #2: история, затем живой поток; текст стримится, вызовы tool одной
   строкой с раскрытием, thinking свёрнут.
3. **Запрос к человеку из GitHub.** #4 уходит в Ожидание: в issue #4 один комментарий «Запрос к человеку» с
   вариантами, карточка подсвечена, Слот освобождён (#3 может быть взят, когда #2 закончит).
   Ответить комментарием «русский» в issue. Ожидается: реакция 🚀 на комментарий, Агент продолжает,
   в результате tool видна строка «кто и откуда».
4. **Конвейер до merge (#2).** Реализация -> QA (Круг 1 из 3) -> Merge. Ожидается: заголовок PR без
   `WIP:` только после approved, QA не считает `WIP:` blocker'ом; squash merge с сообщением = заголовок PR, тело
   пустое; все коммиты ветки и squash-коммит одной строкой Conventional Commits, без `Co-Authored-By`,
   `Claude-Session` и «Generated with» (проверка: `git -C ~/auto-dev-local/repo log origin/main -3 --format='%B---'`
   после `git -C ~/auto-dev-local/repo fetch`); remote-ветка удалена;
   issue закрыта как completed; итоговый комментарий в issue со ссылкой на PR; в Epic отмечена строка
   «Есть slugify с тестами»; локальный worktree удалён (`ls ~/auto-dev-local/repo/.claude/worktrees`).
5. **Блокер.** После закрытия #2 на следующем опросе взята #3.
6. **Диалог.** Пока #3 в Реализации, написать в поле Диалога «добавь JSDoc». Ожидается: сообщение в очереди
   «ещё не доставлено» (можно удалить), доставка после конца Хода, Агент учитывает.
7. **Остановить ход.** На работающем Агенте нажать «Остановить ход»: Ход прерывается, Сессия жива,
   следующее сообщение Диалога продолжает её.
8. **Пауза.** Тумблер «Пауза»: новые Задачи и Круги не стартуют, живой Ход дорабатывает. Снять Паузу.
9. **Восстановление меток.** У Задачи в работе руками снять assignee и вернуть `ready-for-agent`.
   За один опрос Оркестратор молча возвращает assignee и снимает метку.
10. **Рестарт.** Посреди Хода остановить процесс (Ctrl+C) и запустить снова. Ожидается: Агент
    возобновлён с места, Стадия та же, дублей PR и комментариев нет.
11. **Отмена.** Создать ещё одну Задачу с `ready-for-agent`, дождаться взятия, закрыть issue руками.
    Ожидается: Агент остановлен, PR закрыт, ветки и worktree удалены, в UI «Отменена». Reopen ничего не запускает.
12. **Закрытие вехи.** Когда закрыты #2, #3, #4 и отмечены все критерии: закрыты Epic и веха. Если критерий
    не отмечен (Реализатор не вписал строку в PR), на Epic появляются `ready-for-human` и комментарий; отметить
    вручную, веха закроется при сверке в течение 10 мин.
13. **Тупик (по желанию).** В Настройках лимит Кругов = 1, создать Задачу с противоречивым требованием.
    Ожидается: `ready-for-human`, assignee снят, комментарий-причина, worktree остаётся. Вернуть
    `ready-for-agent`: новая попытка с суффиксом `-r2`, старый PR закрыт.
14. **Режим планирования.** Переключатель в шапке -> «новая» -> описать мелкую фичу. Ожидается: Планировщик
    создаёт веху, Epic и Задачи с `ready-for-agent`, ничего не коммитит; «Завершить» гасит процесс; повторный
    вход предлагает продолжить прошлую. Созданные Задачи берутся на следующем опросе.
15. **Ломающее изменение (по желанию).** Задача «Переименовать hello в sayHello, старое имя удалить».
    Ожидается: заголовок PR с `!` (`refactor!: ...`), в теле PR секция `## Ломающие изменения` в 1-3 строки,
    squash-коммит = заголовок плюс одна запись `BREAKING CHANGE: ...` в теле и больше ничего.
16. **Статистика и Настройки.** Страница «Статистика» показывает взятые и влитые Задачи, график лимита и
    журнал. В Настройках смена `max_parallel_tasks` применяется без рестарта.

Если всё прошло, остановить локальный процесс.

## Этап 4. Релиз-кандидат 0.9.0

1. Влить в `main` и сделать репозиторий публичным (установщик качает скрипты и релиз без авторизации):

   ```
   cd ~/Developer/lembdev/auto-dev
   git switch main && git merge --ff-only spec-1-auto-dev && git push origin main
   gh repo edit lembdev/auto-dev --visibility public --accept-visibility-change-consequences
   ```

2. Версия и тег:

   ```
   npm version 0.9.0 -m "chore: release %s"
   git push origin main --follow-tags
   gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   gh release view v0.9.0
   ```

   Ожидается: workflow зелёный, в релизе архив `auto-dev-0.9.0.tar.gz`, релиз помечен latest.

## Этап 5. Установка на Proxmox

Одна Установка = один Продукт. Для проверки ставим отдельный контейнер под песочницу; Продукт Breedly
потом ставится отдельной Установкой.

1. В shell хоста Proxmox от root:

   ```
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/lembdev/auto-dev/main/ct/auto-dev.sh)"
   ```

   Ожидается: создан unprivileged LXC Debian 13 (4 vCPU, 8 GB, 40 GB), в конце выведен адрес мастера.

2. Проверки в контейнере (`<ctid>` из вывода установщика):

   ```
   pct exec <ctid> -- systemctl is-active auto-dev
   pct exec <ctid> -- su - auto-dev -c 'claude --version'
   pct exec <ctid> -- ls -l /opt/auto-dev /var/lib/auto-dev
   pct exec <ctid> -- curl -s localhost:8080/api/health
   ```

   Ожидается: `active`, `claude` установлен, `current -> releases/0.9.0`, health отдаёт `0.9.0`.

3. Мастер на `http://<ip>:8080` с песочницей и новым PAT. Создать в песочнице одну простую Задачу с
   `ready-for-agent` и пройти сценарий 1, 3 и 4 этапа 3.

4. Перезагрузка контейнера: `pct reboot <ctid>`, через минуту health снова отвечает, незаконченная Задача
   продолжается.

## Этап 6. Релиз 1.0.0, обновление и откат

1. Пока в песочнице идёт Задача, выпустить `1.0.0`:

   ```
   cd ~/Developer/lembdev/auto-dev
   npm version 1.0.0 -m "chore: release %s"
   git push origin main --follow-tags
   gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

2. Обновить Установку: `pct exec <ctid> -- update` (кнопка «Обновить» в UI делает то же, но баннер
   появляется только при ежесуточной проверке).

   Ожидается: Пауза с причиной «обновление», ожидание текущего Хода до 10 мин, `current -> releases/1.0.0`,
   health отдаёт `1.0.0`, Пауза снята, Агент продолжил Задачу, `runtime.db` и `/etc/auto-dev/env` на месте.
   Повторный `update` ничего не делает.

3. Откат: `pct exec <ctid> -- update --rollback`. Ожидается: `current -> releases/0.9.0`, health `0.9.0`
   (схема не менялась, откат разрешён). Вернуть: `pct exec <ctid> -- update`, health снова `1.0.0`.

Если этапы 5 и 6 прошли, `1.0.0` остаётся опубликованным релизом. Если нет: снять пометку latest с `v1.0.0`
(`gh release edit v1.0.0 --prerelease`), завести баг, после исправления выпустить `1.0.1`.

## Этап 7. Продукт

Новая Установка тем же однострочником, мастер с `Breedly/breedly-api`, PAT на этот репозиторий. Песочницу и
тестовый контейнер можно удалить (`pct destroy <ctid>`, `gh repo delete lembdev/auto-dev-sandbox`).
