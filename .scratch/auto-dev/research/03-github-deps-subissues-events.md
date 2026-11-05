# GitHub как единственный источник задач: зависимости, sub-issues, milestones, события, draft PR, бот

Дата исследования: 2026-11-04. Источники: docs.github.com (REST / GraphQL / webhooks / Actions), cli.github.com, github.blog/changelog. Факты, помеченные «проверено `gh api`», подтверждены read-only запросами к публичным репозиториям через `gh` 2.102.1 (аккаунт lembdev, scope `repo`, PAT classic). Ничего не создавалось и не менялось.

## Выводы для auto-dev

1. **Зависимости между issue (blocked by / blocking) нативные, GA с 2025-08-21, есть REST, GraphQL, webhooks и `gh`.** Работают в репозиториях личных аккаунтов (проверено `gh api` на публичном репо `dereknex/immune-brain`, owner.type = User). Лимит: до 50 связей на каждый тип отношения. Для приватных личных репо отдельного подтверждения нет, но и ограничений в документации нет (не подтверждено).
2. **«Есть ли у issue открытые блокеры» отвечает одно поле без дополнительных запросов**: `issue_dependencies_summary.blocked_by` считает только открытые блокеры, `total_blocked_by` считает открытые и закрытые. Проверено `gh api`: issue с одним закрытым и одним открытым блокером даёт `blocked_by: 1, total_blocked_by: 2`. В GraphQL то же: `issueDependenciesSummary { blockedBy totalBlockedBy }`. Условие «issue готова к работе» = `state == open && blocked_by == 0`.
3. **Sub-issues: до 100 на родителя, до 8 уровней вложенности, GA с 2025-04-09, работают в личных репо** (проверено `gh api` на `OscarVargas97/otteretro-catalogo`, owner.type = User). `sub_issues_summary { total, completed, percent_completed }` даёт прогресс эпика. Sub-issue должна принадлежать тому же владельцу, что и родитель.
4. **Milestone: «всё закрыто» = `open_issues == 0` в объекте milestone** (`GET /repos/{o}/{r}/milestones/{n}`), закрыть через `PATCH ... {"state":"closed"}`. У `gh` нет команды `gh milestone`, только `gh api` и фильтр `gh issue list --milestone`.
5. **Issue types только для организаций.** В личном репо `type` всегда `null`, GraphQL `createIssueType` требует `ownerId` организации, при переносе репо из org в личный аккаунт типы удаляются. Для auto-dev использовать labels: создание `POST /repos/{o}/{r}/labels`, описание до 100 символов, лимит на число labels в документации не указан.
6. **Наблюдение за комментариями без публичного IP: REST polling двух репо-уровневых endpoint с ETag.** `GET /repos/{o}/{r}/issues/comments?sort=updated&direction=desc&since=…` и `GET /repos/{o}/{r}/issues?state=all&sort=updated&since=…` покрывают все 10 issue за 2 запроса, 304 по `If-None-Match` не тратит primary limit (проверено `gh api -i`: `X-Ratelimit-Used` не изменился на 304). При интервале 15 с это максимум 480 запросов/час против лимита 5000/час для PAT, то есть меньше 10% бюджета даже без 304. Events API не годится как основной канал: `X-Poll-Interval: 60` и задержка «от 30 с до 6 ч». Webhooks через туннель и Actions на self-hosted runner описаны как опции второго уровня.
7. **Draft PR: `POST /repos/{o}/{r}/pulls` с `"draft": true`, перевод в ready через GraphQL `markPullRequestReadyForReview` или `gh pr ready`.** REST endpoint для смены draft-статуса нет. Draft PR доступны в публичных репо на GitHub Free, в приватных только на Team / Enterprise Cloud (цитата из REST docs ниже). Merge: синхронный `PUT .../merge` с `merge_method` или рекомендуемый GitHub асинхронный `PUT .../merge-async` + опрос `GET .../merge-async/{uuid}`. Auto-close `closes #N` срабатывает только при merge в default branch.
8. **Для различения комментариев человека и бота нужен GitHub App, не PAT.** Комментарий от installation token приходит с `user.login = "<slug>[bot]"`, `user.type = "Bot"` и заполненным `performed_via_github_app` (проверено `gh api` на комментарии `cli-triage[bot]`). С PAT бот неотличим от владельца токена кроме как по `user.login`. GitHub App регистрируется под личным аккаунтом, webhook можно не включать, лимит 5000 запросов/час на installation, token живёт 1 час, JWT не более 10 минут.
9. **Fine-grained PAT (если всё же PAT): Issues write, Pull requests write, Contents write, Metadata read.** Merge PR требует Contents write, не Pull requests.
10. **Secondary rate limits важнее primary для бота**: не более 80 content-creating запросов в минуту и 500 в час, не более 100 параллельных запросов, между mutating запросами ждать 1 с, запросы делать последовательно. Создание комментария, зависимости, sub-issue помечены в docs как подверженные secondary limiting.
11. **REST API version**: действующая новая версия `2026-03-10`, старая `2022-11-28` остаётся default и поддерживается до 2028-03-10. В новой версии из issue/PR убраны `assignee` (единственное число) и `merge_commit_sha`. Для auto-dev лучше явно слать `X-GitHub-Api-Version: 2026-03-10` и использовать `assignees`.

## 1. Issue dependencies (blocked by / blocking)

### Статус и лимиты

- GA с 2025-08-21: «Dependencies on issues are now generally available!», «You can link up to 50 issues for each relationship type», «Issue dependencies are fully supported in the API and webhooks».
  Источник: https://github.blog/changelog/2025-08-21-dependencies-on-issues/
- Ограничения по плану или типу аккаунта в документации не указаны. Проверено `gh api`: публичный репозиторий `dereknex/immune-brain` (owner.type = User, visibility = public), issue #396 имеет `blocked_by: 1`, `GET .../dependencies/blocked_by` возвращает issue #395 (open). Приватные личные репо: не подтверждено.
- Поиск: `is:blocked`, `is:blocking`, `blocked-by:<n>`, `blocking:<n>` (тот же changelog). Замечание: индекс поиска отстаёт, в выборке `is:blocked` встречались issue с `total_blocked_by: 0`; для точного состояния читать сам issue, не полагаться на search.

### REST

Источник: https://docs.github.com/en/rest/issues/issue-dependencies

| Операция | Endpoint | Тело |
|---|---|---|
| Список блокеров | `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | `per_page` до 100 |
| Добавить блокер | `POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | `{"issue_id": <id>}` (это `id`, не `number`) |
| Убрать блокер | `DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}` | нет |
| Кого блокирует | `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking` | `per_page` до 100 |

- `POST` и `DELETE`: «Creating content too quickly using this endpoint may result in secondary rate limiting.»
- Ответы возвращают объекты Issue; в каждом есть `issue_dependencies_summary: { blocked_by, blocking, total_blocked_by, total_blocking }`.
- Endpoint «blocking add/remove» нет: отношение задаётся только со стороны блокируемой issue (`blocked_by`). Чтобы «A blocks B», вызывать `POST /issues/B/dependencies/blocked_by {"issue_id": A.id}`.
- Права fine-grained PAT: «Issues» write для POST, «Issues» read для GET.
  Источник: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens

### Проверка «есть ли открытые блокеры»

Проверено `gh api` на `valence-works/elsa-control#914`:

```
issue_dependencies_summary: {"blocked_by":1,"blocking":1,"total_blocked_by":2,"total_blocking":1}
GET .../dependencies/blocked_by -> #849 closed, #672 open
```

То есть `blocked_by` = число открытых блокеров, `total_blocked_by` = открытых плюс закрытых. GraphQL описания полей (интроспекция схемы через `gh api graphql`):

- `IssueDependenciesSummary.blockedBy`: «Count of issues this issue is blocked by»
- `IssueDependenciesSummary.totalBlockedBy`: «Total count of issues this issue is blocked by (open and closed)»

Для списка готовых к работе issue одним запросом:

```
GET /repos/{owner}/{repo}/issues?state=open&per_page=100
# фильтр на клиенте: .issue_dependencies_summary.blocked_by == 0 and (.pull_request == null)
```

Поле `issue_dependencies_summary` присутствует и в списке issues, и в search results (проверено `gh api`).

### GraphQL

Интроспекция живой схемы (`gh api graphql`, 2026-11-04):

- `Issue.blockedBy(orderBy: IssueDependencyOrder, first, last, after, before)`: «A list of issues that are blocking this issue.»
- `Issue.blocking(...)`: «A list of issues that this issue is blocking.»
- `Issue.issueDependenciesSummary`: `blockedBy`, `blocking`, `totalBlockedBy`, `totalBlocking`.
- Мутации: `addBlockedBy(input: { issueId, blockingIssueId })`, `removeBlockedBy`.
- Справочник: https://docs.github.com/en/graphql/reference/mutations#addblockedby, https://docs.github.com/en/graphql/reference/objects#issue

Пример:

```graphql
query($owner:String!, $repo:String!) {
  repository(owner:$owner, name:$repo) {
    issues(states: OPEN, first: 100) {
      nodes {
        number
        issueDependenciesSummary { blockedBy totalBlockedBy }
        blockedBy(first: 50) { nodes { number state } }
      }
    }
  }
}
```

```graphql
mutation { addBlockedBy(input:{ issueId:"I_kw...", blockingIssueId:"I_kw..." }) { clientMutationId } }
```

### Webhooks и timeline

- Webhook `issue_dependencies`, actions: `blocked_by_added`, `blocked_by_removed`, `blocking_added`, `blocking_removed`; payload: `blocked_issue_id`, `blocked_issue`, `blocking_issue_id`, `blocking_issue`, `blocking_issue_repo` / `blocked_issue_repo`. Для GitHub App нужен минимум «Issues» read.
  Источник: https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_dependencies
- Timeline issue (`GET /repos/{owner}/{repo}/issues/{issue_number}/timeline`) содержит события `blocked_by_added`, `blocked_by_removed`, `blocking_added`, `blocking_removed` с полями `blocked_by` / `blocking` (Issue Reference).
  Источник: https://docs.github.com/en/rest/issues/timeline

### gh CLI

Поддержка с `gh` v2.94.0 (changelog 2026-06-10): https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/

Проверено локально на `gh` 2.102.1 (`gh issue create --help`, `gh issue edit --help`, `gh issue list --json`):

```
gh issue create --blocked-by 200,201 --blocking 300
gh issue edit 123 --add-blocked-by 200 --add-blocking 300,301
gh issue edit 123 --remove-blocked-by 200 --remove-blocking 300
gh issue list --json number,blockedBy,blocking,subIssuesSummary --jq '.[] | select(.blockedBy|length==0)'
gh issue view 123 --json blockedBy,blocking,parent,subIssues,subIssuesSummary,issueType
```

Замечание: `--json blockedBy` возвращает список, а не summary; `issueDependenciesSummary` среди JSON-полей `gh issue list/view` отсутствует (список полей проверен локально). Для счётчика открытых блокеров проще `gh api`.

## 2. Sub-issues

### Статус и лимиты

- «You can add up to 100 sub-issues per parent issue and create up to eight levels of nested sub-issues.»
  Источник: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- GA с 2025-04-09 (вместе с issue types и advanced search): https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/
- Лимит поднят с 50 до 100 в changelog 2024-12-12: https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/
- С 2025-09-11 sub-issues по умолчанию наследуют Project и Milestone родителя: https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/
- Личные репо: проверено `gh api` на `OscarVargas97/otteretro-catalogo#58` (owner.type = User): `sub_issues_summary: {"total":3,"completed":0,"percent_completed":0}`, `GET .../sub_issues` вернул 3 элемента.

### REST

Источник: https://docs.github.com/en/rest/issues/sub-issues

| Операция | Endpoint | Тело |
|---|---|---|
| Список sub-issues | `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | `per_page` до 100 |
| Добавить | `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | `{"sub_issue_id": <id>, "replace_parent": false}` |
| Убрать | `DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue` | `{"sub_issue_id": <id>}` (единственное число в пути) |
| Переставить | `PATCH /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority` | `{"sub_issue_id", "after_id" | "before_id"}` |
| Родитель | `GET /repos/{owner}/{repo}/issues/{issue_number}/parent` | нет |

- `sub_issue_id`: «The sub-issue must belong to the same repository owner as the parent issue.»
- `replace_parent`: «Option that, when true, instructs the operation to replace the sub-issues current parent issue.»
- В объекте Issue: `sub_issues_summary: { total, completed, percent_completed }` и `parent_issue_url`.
- POST/DELETE помечены как подверженные secondary rate limiting.
- Права fine-grained PAT: «Issues» write / read.

### GraphQL

Интроспекция: `Issue.parent`, `Issue.subIssues(first, last, after, before)`, `Issue.subIssuesSummary { total, completed, percentCompleted }`; мутации `addSubIssue(input: { issueId, subIssueId | subIssueUrl, replaceParent })`, `removeSubIssue`, `reprioritizeSubIssue`.

### Webhooks

Webhook `sub_issues`, actions: `parent_issue_added`, `parent_issue_removed`, `sub_issue_added`, `sub_issue_removed`; нужен «Issues» read.
Источник: https://docs.github.com/en/webhooks/webhook-events-and-payloads#sub_issues

### gh CLI

```
gh issue create --parent 100
gh issue edit 23 --parent 100 | --remove-parent
gh issue edit 100 --add-sub-issue 123,124 | --remove-sub-issue 123
gh issue list --json number,parent,subIssuesSummary
```

## 3. Milestones

Источник: https://docs.github.com/en/rest/issues/milestones

| Операция | Endpoint | Тело |
|---|---|---|
| Создать | `POST /repos/{owner}/{repo}/milestones` | `{"title" (required), "state": "open"|"closed", "description", "due_on": "YYYY-MM-DDTHH:MM:SSZ"}` |
| Обновить / закрыть | `PATCH /repos/{owner}/{repo}/milestones/{milestone_number}` | `{"state": "closed"}` |
| Получить | `GET /repos/{owner}/{repo}/milestones/{milestone_number}` | нет |
| Список | `GET /repos/{owner}/{repo}/milestones?state=open|closed|all&sort=due_on|completeness&direction=asc|desc` | нет |
| Удалить | `DELETE /repos/{owner}/{repo}/milestones/{milestone_number}` | нет, ответ 204 |

- В ответе есть `open_issues` и `closed_issues` (integer, required). Документация не расшифровывает, что именно считается, но по семантике это число открытых и закрытых issue в milestone. Условие «milestone готов к закрытию» = `open_issues == 0 && closed_issues > 0`. Нюанс: GitHub считает PR тоже issue («GitHub's REST API considers every pull request an issue»), поэтому открытый PR с этим milestone тоже попадёт в `open_issues` (не подтверждено для этого конкретного счётчика, следует из общей модели; auto-dev не должен вешать milestone на PR или должен учитывать это).
- Альтернатива в GraphQL с явными фильтрами: `Milestone.issues(states: [OPEN]) { totalCount }` (аргументы `issues(orderBy, labels, states, filterBy, ...)` проверены интроспекцией). Это считает только issue, без PR.
- Привязка issue: `PATCH /repos/{owner}/{repo}/issues/{n}` с `"milestone": <number>` или `null`; «Only users with push access can set the milestone», без push access молча игнорируется.
  Источник: https://docs.github.com/en/rest/issues/issues
- Список issue в milestone: `GET /repos/{owner}/{repo}/issues?milestone=<number>&state=all` (`milestone=*` любой, `milestone=none` без milestone).
- Webhook `milestone` (actions created/closed/opened/edited/deleted): https://docs.github.com/en/webhooks/webhook-events-and-payloads#milestone (текст раздела в этом исследовании не цитировался).
- Права fine-grained PAT: «Issues» write.

### gh CLI

Нативной команды нет (`gh milestone` даёт `unknown command`, проверено локально). Использовать:

```
gh api -X POST repos/{owner}/{repo}/milestones -f title="v0.2"
gh api -X PATCH repos/{owner}/{repo}/milestones/3 -f state=closed
gh api repos/{owner}/{repo}/milestones/3 --jq '.open_issues'
gh issue list --milestone "v0.2" --state all --json number,state
gh issue create --milestone "v0.2"
gh issue edit 23 --milestone "v0.2" | --remove-milestone
```

## 4. Issue types и labels

### Issue types

- Настраиваются только на уровне организации: «You can create up to 25 issue types that your organization members can apply to issues», defaults «task, bug, and feature».
  Источник: https://docs.github.com/en/issues/tracking-your-work-with-issues/configuring-issues/managing-issue-types-in-an-organization
- Перенос репо из org в личный аккаунт: «When you transfer a repository from an organization to a personal account, all issue types are removed from issues.»
  Источник: https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository
- GraphQL `createIssueType(input: { ownerId })`: «The ID for the organization on which the issue type is created» (интроспекция).
- CLI changelog: «Issue types are configured at the organization level».
- REST: поле `type` в `POST/PATCH /repos/{owner}/{repo}/issues` («Only users with push access can set the type»); в личных репо приходит `type: null` (проверено `gh api` на `lembdev/*`).
  Источник: https://docs.github.com/en/rest/issues/issues и https://github.blog/changelog/2025-03-18-github-issues-projects-rest-api-support-for-issue-types/
- Вывод: для личного репозитория типы недоступны, роль типа играют labels (например `type:feature`, `type:bug`).

### Labels

Источник: https://docs.github.com/en/rest/issues/labels

| Операция | Endpoint | Тело |
|---|---|---|
| Создать | `POST /repos/{owner}/{repo}/labels` | `{"name" (required), "color": "f29513" (без #), "description": до 100 символов}` |
| Обновить | `PATCH /repos/{owner}/{repo}/labels/{name}` | `new_name`, `color`, `description`, `archived` (boolean) |
| Удалить | `DELETE /repos/{owner}/{repo}/labels/{name}` | нет |
| Добавить на issue | `POST /repos/{owner}/{repo}/issues/{issue_number}/labels` | `{"labels": ["a","b"]}` |
| Заменить набор | `PATCH /repos/{owner}/{repo}/issues/{issue_number}` | `{"labels": [...]}` (пустой массив очищает) |

- «The name and color parameters are required.» Лимиты на длину имени и число labels в документации не указаны (не подтверждено).
- `archived: true`: архивные labels «cannot be added to issues or pull requests» (удобно для вывода статусов из оборота без потери истории).
- Создание может вернуть 422 «Validation failed, or the endpoint has been spammed».
- Права fine-grained PAT: «Issues» write.
- `gh label create NAME --color HEX --description TEXT`, `gh label list`, `gh issue edit N --add-label/--remove-label`.

## 5. Наблюдение за комментариями и изменениями без публичного IP

### Rate limits (цифры)

Источник: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api

| Субъект | Primary limit |
|---|---|
| PAT (classic или fine-grained), все запросы пользователя | 5 000 запросов/час |
| GitHub App installation token (не Enterprise Cloud) | 5 000/час, +50 за каждый репозиторий сверх 20 и за каждого пользователя org сверх 20, максимум 12 500/час |
| `GITHUB_TOKEN` в Actions | 1 000/час на репозиторий |
| Без аутентификации | 60/час на IP |
| GraphQL | 5 000 points/час для пользователя и для installation, минимум 1 point на запрос (https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api) |

Secondary limits (там же):

- «No more than 100 concurrent requests are allowed.»
- Не более 900 points в минуту на REST endpoint (GET = 1 point, POST/PATCH/PUT/DELETE = 5).
- «No more than 90 seconds of CPU time per 60 seconds of real time is allowed.»
- Не более 80 content-generating запросов в минуту и 500 в час; у некоторых endpoint лимиты ниже.

Best practices: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api

- «Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized with an `Authorization` header.»
- «Conditional requests for unsafe methods, such as `POST`, `PUT`, `PATCH`, and `DELETE` are not supported.»
- «A different page size, page number, or filter produces a different response with a different `etag`.»
- «Poll only as often as you need to, on a fixed schedule.», «If a response includes an `x-poll-interval` header, wait at least that many seconds».
- «you should make requests serially instead of concurrently», для mutating запросов «wait at least one second between each request».
- «Continuing to make requests while you are rate limited may result in the banning of your integration.»

Проверено `gh api -i` на `repos/cli/cli/issues/comments?...`: повторный запрос с `If-None-Match: <etag>` вернул `304 Not Modified`, `X-Ratelimit-Used` не увеличился. Заголовок `Cache-Control: private, max-age=60` на ответах issue.

### (a) REST polling: что именно опрашивать

Два endpoint покрывают все открытые issue репозитория:

1. Новые и отредактированные комментарии по всему репо:
   `GET /repos/{owner}/{repo}/issues/comments?sort=updated&direction=desc&since=<ISO8601>&per_page=100`
   `since`: «Only show results that were last updated after the given time» (ловит и правки).
   Источник: https://docs.github.com/en/rest/issues/comments
2. Изменения самих issue (закрытие, labels, milestone, новые issue, зависимости, PR):
   `GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc&since=<ISO8601>&per_page=100`
   Возвращает и PR («You can identify pull requests by the pull_request key»).
   Источник: https://docs.github.com/en/rest/issues/issues

Важно: `since` менять только при наличии изменений, иначе ETag меняется каждый цикл и 304 не будет. Практичный вариант: держать `since` = время последнего обнаруженного изменения минус запас, а `If-None-Match` от последнего ответа с тем же URL.

Review-комментарии на PR в `issues/comments` не попадают; для них отдельно:
`GET /repos/{owner}/{repo}/pulls/comments?sort=updated&direction=desc&since=…` (https://docs.github.com/en/rest/pulls/comments) и reviews по конкретному PR `GET /repos/{owner}/{repo}/pulls/{n}/reviews`.

Бюджет (PAT 5 000/час, 3 endpoint на цикл, без учёта бесплатных 304):

| Интервал | Запросов/час | Доля лимита |
|---|---|---|
| 10 с | 1 080 | 22% |
| 15 с | 720 | 14% |
| 30 с | 360 | 7% |
| 60 с | 180 | 4% |

Поштучный опрос 10 issue (`GET /issues/{n}/comments?since=`) при 30 с даёт 1 200/час, то есть в 3 раза дороже при той же задержке; оправдан только как уточняющий запрос после обнаружения изменения.

GraphQL-альтернатива: один запрос `repository { issues(states: OPEN, first: 20, orderBy:{field: UPDATED_AT, direction: DESC}) { nodes { number updatedAt comments(last: 10) { nodes { id author { login __typename } createdAt updatedAt body } } } } }` стоит 1 point, 5 000/час; ETag для GraphQL (POST) недоступен, каждый запрос платный.

### (b) Events API / Timeline API

- `GET /repos/{owner}/{repo}/events`: «Events are optimized for polling with the "ETag" header», `X-Poll-Interval` (проверено: 60), «is not built to serve real-time use cases», «event latency can be anywhere from 30s to 6h», «Only events created within the past 30 days will be included», «up to 300 events».
  Источник: https://docs.github.com/en/rest/activity/events
  Вывод: не подходит как основной канал реакции на комментарии.
- `GET /repos/{owner}/{repo}/issues/{issue_number}/timeline`: полная история по одной issue, включая `commented`, `cross-referenced`, `labeled`, `milestoned`, `closed`, `blocked_by_added`, `sub_issue_added`, `issue_type_added`; у каждого события есть `actor`, `created_at`, `performed_via_github_app`. Параметр `exclude` для отсечения типов. Удобен для восстановления состояния одной issue после рестарта, но не для сканирования 10 issue каждые N секунд (10 запросов на цикл).
  Источник: https://docs.github.com/en/rest/issues/timeline
- Notifications API (`GET /notifications`): «Notifications are optimized for polling with the `Last-Modified` header», `X-Poll-Interval` (пример 60), 304 не тратит лимит, но «These endpoints only support authentication using a personal access token (classic)» со scope `notifications`/`repo`, и уведомления приходят только по тредам, где аккаунт участвует. Для GitHub App неприменимо.
  Источник: https://docs.github.com/en/rest/activity/notifications

### (c) Webhooks через туннель или через Actions на self-hosted runner

Webhook-события, которые нужны auto-dev: `issue_comment` (created/edited/deleted/pinned/unpinned, «occurs for comments on both issues and pull requests»), `issues` (opened, edited, closed, reopened, labeled, unlabeled, milestoned, demilestoned, typed, untyped, ...), `issue_dependencies`, `sub_issues`, `milestone`, `pull_request` (`ready_for_review`, `converted_to_draft`, `closed` с `merged: true/false`), `pull_request_review`, `pull_request_review_comment`.
Источник: https://docs.github.com/en/webhooks/webhook-events-and-payloads

Варианты доставки на машину без публичного IP:

- **smee.io** (официально в docs как способ тестирования): «The following sections demonstrate how to use smee.io to provide a webhook proxy URL and forward webhooks», клиент `npm install --global smee-client`, `smee --url WEBHOOK_PROXY_URL --path /PATH --port PORT`. Ограничения, SLA и пригодность для production в docs не описаны (не подтверждено). Payload проходит через сторонний сервис, канал публичный по URL.
  Источник: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks
- **Cloudflare Quick Tunnel** (`trycloudflare.com`): «You do not need a Cloudflare account or domain», «Quick Tunnels are for testing and development», «Quick Tunnels have no uptime guarantee», «The hostname changes each time you create a Quick Tunnel», «Each Quick Tunnel supports up to 200 in-flight requests». Для стабильного hostname нужен именованный Cloudflare Tunnel с аккаунтом и доменом.
  Источник: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- **ngrok Free**: «Up to 3 online endpoints», «Assigned dev domain for public endpoints», «Up to 1GB data transfer», «Up to 20k HTTP/S requests» в месяц, «Interstitial page on HTTP/S endpoints» (interstitial для webhook POST с не-browser клиентом обычно не мешает, но это не подтверждено в этом исследовании).
  Источник: https://ngrok.com/pricing
- **GitHub Actions + self-hosted runner**: workflow на `issue_comment` / `issues` / `pull_request` запускает job на self-hosted runner внутри LAN, job дергает локальный orchestrator (HTTP на localhost или unix socket). Runner сам ходит наружу: «The host machine must be able to make outbound HTTPS connections over port 443», «Self-hosted runners connect to GitHub to receive job assignments», входящих портов не требуется. Long-poll до 50 с описан только в docs GHES 3.2 (https://docs.github.com/en/enterprise-server@3.2/actions/hosting-your-own-runners/about-self-hosted-runners), в актуальных docs github.com этой формулировки нет (не подтверждено для текущей версии). Self-hosted runners бесплатны: «Self-hosted runners» в списке «The following usage remains free». Ограничения: workflow для `issue_comment` и `issues` «will only trigger a workflow run if the workflow file exists on the default branch»; `GITHUB_TOKEN` 1 000/час на репо; задержка старта job (очередь Actions) и необходимость держать runner-процесс.
  Источники: https://docs.github.com/en/actions/reference/runners/self-hosted-runners, https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows, https://docs.github.com/en/billing/concepts/product-billing/github-actions

Для GitHub App webhook необязателен: «if you do not want your app to receive webhook events, deselect Active».
Источник: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app

### (d) Polling через `gh api --jq`

`gh api` поддерживает `-H "If-None-Match: ..."`, `-i` (вывести заголовки), `--cache 60s` (локальный кэш ответа), `--paginate`, `--jq` (проверено `gh api --help`). Пример цикла:

```
ETAG=$(gh api -i "repos/$R/issues/comments?sort=updated&direction=desc&since=$SINCE&per_page=100" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
gh api -i -H "If-None-Match: $ETAG" "repos/$R/issues/comments?sort=updated&direction=desc&since=$SINCE&per_page=100" \
  | sed -n '1p'   # HTTP/2.0 304 Not Modified
gh api "repos/$R/issues/comments?sort=updated&direction=desc&since=$SINCE" \
  --jq '.[] | select(.user.type != "Bot") | {issue: (.issue_url|split("/")|last), id, user: .user.login, updated_at}'
```

Замечание: `gh issue list --json comments` тянет комментарии через GraphQL и не даёт ETag; для polling предпочтительнее `gh api` REST.

### Рекомендация для 10 открытых issue

1. Основной канал: REST polling раз в 15-20 с двумя запросами (`issues/comments?sort=updated&since=`, `issues?state=all&sort=updated&since=`) плюс `pulls/comments?sort=updated&since=` раз в 30-60 с, всё с `If-None-Match`. Потолок около 700 запросов/час без 304, реально в разы меньше. Бюджет на запись остаётся с запасом, но соблюдать 1 с между mutating запросами и не более 80 content-creating в минуту.
2. При обнаружении изменения в issue: точечно `GET /issues/{n}` (summary зависимостей и sub-issues) и при необходимости `GET /issues/{n}/timeline`.
3. Webhook через туннель рассматривать как ускоритель, не как единственный канал: polling остаётся fallback при обрыве туннеля. Если выбирать туннель, то именованный Cloudflare Tunnel (стабильный hostname) или Actions на self-hosted runner (ничего стороннего, но задержка очереди Actions).
4. Events API и Notifications API не использовать.
5. Фильтровать собственные комментарии: с GitHub App по `user.type == "Bot"` и `performed_via_github_app.slug`, с PAT по `user.login`.

## 6. Draft PR

### Создание и статус draft

- `POST /repos/{owner}/{repo}/pulls` с `title`, `head`, `base`, `body`, `draft: true`. «Draft pull requests are available in public repositories with GitHub Free and GitHub Free for organizations, GitHub Pro, and legacy per-repository billing plans, and in public and private repositories with GitHub Team and GitHub Enterprise Cloud.»
  Источник: https://docs.github.com/en/rest/pulls/pulls
  Вывод: в приватном личном репо на Free или Pro draft PR недоступен (не подтверждено экспериментально; цитата выше это утверждает). Для приватного репо auto-dev придётся заменить draft на label `wip` или на блокирующий статус.
- «Draft pull requests cannot be merged, and code owners are not automatically requested to review them.», «Marking a pull request as ready for review will request reviews from any code owners.»
  Источник: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests
- Перевод в ready for review: только GraphQL `markPullRequestReadyForReview(input: { pullRequestId })`, обратно `convertPullRequestToDraft`. В `PATCH /pulls/{n}` поля `draft` нет (поля: `title`, `body`, `state`, `base`, `maintainer_can_modify`).
  Источник: https://docs.github.com/en/graphql/reference/mutations#markpullrequestreadyforreview
- Webhook `pull_request` с actions `ready_for_review` и `converted_to_draft`.

gh CLI (проверено `--help`): `gh pr create --draft`, `gh pr ready [<number>]`, `gh pr ready --undo` («If supported by your plan, convert to draft with --undo»). Источник: https://cli.github.com/manual/gh_pr_ready

### Merge

- Синхронный: `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` с `merge_method: merge|squash|rebase`, `commit_title`, `commit_message`, `sha` («SHA that pull request head must match to allow merge»). Ответы: 200 «if merge was successful», 405 «if merge cannot be performed», 409 «if sha was provided and pull request head did not match». «This endpoint does not support stacked pull requests or merging with a merge queue.»
- Асинхронный (GA 2025-10-01, «now the recommended path for programmatically merging pull requests»): `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async` с теми же `merge_method`, `commit_title`, `commit_message`, `sha` плюс `merge_action: default|direct_merge|merge_queue`, `bypass_rules`. Ответ 202 с `details.uuid`, затем `GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}` с `status: pending|merged|enqueued|failed`; «The result of an asynchronous merge request is retained for 24 hours after its most recent update». 409 если merge уже в очереди.
  Источники: https://docs.github.com/en/rest/pulls/pulls, https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available/
- Проверка «уже смержен»: `GET /repos/{owner}/{repo}/pulls/{pull_number}/merge` даёт 204 (merged) или 404.
- Права fine-grained PAT: merge требует «Contents» write (не «Pull requests»).
- gh: `gh pr merge N --squash|--merge|--rebase [--delete-branch] [--auto]`.
- GraphQL `mergePullRequest(input: { pullRequestId, mergeMethod, commitHeadline, commitBody, expectedHeadOid })` существует, но описание мутации само рекомендует async REST API.

### Auto-close по `closes #N`

- Ключевые слова: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved; в description PR или в commit message.
- «When you merge a linked pull request into the default branch of a repository, its linked issue is automatically closed.» При merge в другую ветку ключевые слова игнорируются и «no links are created».
- Cross-repo: `Fixes octo-org/octo-repo#100`.
- Про draft PR в статье нет отдельного правила; draft нельзя смержить, значит и закрытия не будет до ready + merge.
  Источник: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
- Для auto-dev: полагаться на явное `PATCH /issues/{n} {"state":"closed","state_reason":"completed"}` после подтверждённого merge надёжнее, чем на автозакрытие (merge в не-default ветку, squash с изменённым сообщением и т.п.). Связь PR и issue через `closes #N` в body всё равно полезна для UI.

### Reviews и комментарии к PR программно

Источник: https://docs.github.com/en/rest/pulls/reviews и https://docs.github.com/en/rest/pulls/comments

- Создать review со встроенными комментариями:
  `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`
  `{"commit_id", "body", "event": "APPROVE"|"REQUEST_CHANGES"|"COMMENT", "comments": [{"path", "line", "side": "RIGHT", "start_line", "start_side", "body"}]}`
  «By leaving this blank, you set the review action state to PENDING»; `body` «Required when using REQUEST_CHANGES or COMMENT». Отправка pending review: `POST .../reviews/{review_id}/events` с `event`.
- Одиночный комментарий к строке: `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments` с `body`, `commit_id` (required), `path` (required), `line`, `side`, `start_line`, `start_side`, `subject_type: line|file`; `position` «is closing down. Use line instead». Ответ на комментарий: `POST .../comments/{comment_id}/replies` («Replies to replies are not supported»). «This endpoint triggers notifications», secondary rate limiting.
- Обычный комментарий в обсуждении PR: `POST /repos/{owner}/{repo}/issues/{pull_number}/comments` (PR это issue).
- Чтение: `GET .../pulls/{n}/reviews`, `GET .../pulls/{n}/comments`, `GET /repos/{o}/{r}/pulls/comments?sort=updated&since=`.
- Права fine-grained PAT: «Pull requests» write.
- Ограничение: нельзя approve собственный PR тем же аккаунтом (стандартное поведение GitHub, в этом исследовании не цитировалось, не подтверждено).

## 7. GitHub App vs PAT для бота

### Различимость комментариев

- «An installation token identifies the app as a GitHub App bot account, such as @jenkins[bot].» «A user access token identifies the app as the user who signed into the app, such as @octocat.» «Bot accounts are specific to GitHub Apps and are built into every GitHub App.»
  Источник: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- Проверено `gh api` на комментарии в `cli/cli`:

```
user: {login: "cli-triage[bot]", type: "Bot"}
performed_via_github_app: {id: 3557673, slug: "cli-triage", name: "CLI Triage"}
author_association: "NONE"
```

  Человек даёт `user.type: "User"` и `performed_via_github_app: null`. Оба поля есть в issue comment, в issue, в timeline events.
  Источник: https://docs.github.com/en/rest/issues/comments
- Webhook: «Don't assume `sender` always identifies the person who caused an event» (docs webhooks). Для фильтрации в webhook payload смотреть `comment.user.type` и `comment.performed_via_github_app`, а не только `sender`.
- С PAT комментарии бота выглядят как комментарии владельца токена. Если оркестратор и человек используют один аккаунт, различить их через API нельзя; потребуется отдельный аккаунт для бота (machine user) или маркер в теле комментария. GitHub App снимает эту проблему целиком.

### Аутентификация GitHub App

- Регистрация: «You can register a GitHub App under your personal account or under any organization you own», до 100 apps на аккаунт; webhook можно отключить.
  Источник: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
- Авторизация как installation: «Your app should authenticate as an app installation when you want to attribute app activity to the app», «ideal for automation workflows that don't involve user input».
  Источник: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app
- JWT: «Your JWT must be signed using the RS256 algorithm», `exp` «must be no more than 10 minutes into the future», `iat` рекомендуют «set this 60 seconds in the past», `iss` = client ID или app ID.
  Источник: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
- Installation token: `POST /app/installations/{installation_id}/access_tokens` с JWT в Bearer, «The installation access token will expire after 1 hour», можно сузить `repositories` (до 500) и `permissions`.
  Источник: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- Rate limit installation: 5 000/час (личный аккаунт с 1 репо не получает надбавок), GraphQL 5 000 points/час.
- `gh` не умеет сам генерировать JWT / installation token; нужен клиент (Octokit `@octokit/auth-app`, `ghinstallation` для Go) или свой код; полученный token можно отдать `gh` через `GH_TOKEN`.

### Права

Для GitHub App repository permissions и для fine-grained PAT названия совпадают:
Источник: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens

| Что делает бот | Permission |
|---|---|
| Читать issue, комментарии, milestones, labels, sub-issues, dependencies | Issues: read |
| Создавать issue, комментировать, менять labels/milestone/state, sub-issues, dependencies | Issues: write |
| Создавать PR, review, review comments, ready for review | Pull requests: write |
| Push в ветки, merge PR | Contents: write |
| Базовые сведения о репо | Metadata: read (выдаётся автоматически) |
| Webhook-подписка на `issues`, `issue_comment`, `issue_dependencies`, `sub_issues` | Issues: read |
| (если потребуется) запуск/правка workflow файлов | Workflows: write |

Для PAT classic эквивалент: scope `repo` (проверено заголовком `X-Accepted-Oauth-Scopes: repo` на `GET /repos/{o}/{r}/issues/{n}`).

## Приложение: REST API versions

- Версии: `2026-03-10` (выпущена 2026-03-10, окончание поддержки не назначено) и `2022-11-28` (default при отсутствии заголовка, поддержка до 2028-03-10). «the previous API version will be supported for at least 24 more months», закрытые версии отвечают `410 Gone`.
  Источник: https://docs.github.com/en/rest/about-the-rest-api/api-versions
- Breaking changes `2026-03-10`, касающиеся auto-dev: убран singular `assignee` (использовать `assignees`), убран `merge_commit_sha` из PR payload, убран `use_squash_pr_title_as_default`, `rate` убран из `GET /rate_limit` (читать `resources.core`).
  Источник: https://docs.github.com/en/rest/overview/breaking-changes
- `gh` 2.102.1 сейчас шлёт `X-GitHub-Api-Version-Selected: 2022-11-28` (проверено `gh api -i`); при прямых запросах auto-dev стоит явно слать `X-GitHub-Api-Version: 2026-03-10`.

## Не подтверждено / за рамками

- Доступность issue dependencies и sub-issues в приватных репозиториях личных аккаунтов (проверено только на публичных).
- Точная семантика `open_issues` у milestone в части учёта PR.
- Пригодность smee.io для постоянной работы, SLA и лимиты.
- Текущая формулировка про long polling self-hosted runner (есть только в docs GHES 3.2).
- Недоступность draft PR в приватных репо на Free/Pro подтверждена только цитатой из REST docs, не экспериментом.
- Запрет approve собственного PR тем же аккаунтом.
