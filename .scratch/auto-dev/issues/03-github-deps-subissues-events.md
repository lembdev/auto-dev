# Research: GitHub-примитивы для задач: зависимости, sub-issues, milestones, события

Type: research
Status: resolved

## Question

Что GitHub даёт для модели задач auto-dev и как это достижимо через gh CLI / REST / GraphQL?
- Нативные зависимости issues (blocked by / blocking): API, доступность в личных репозиториях, как читать «есть ли открытые блокеры».
- Sub-issues: API создания и чтения, лимиты.
- Milestones: создание, закрытие, как понять что все issues milestone закрыты.
- Как узнавать о новых комментариях и изменениях с VM в домашней сети без публичного IP: polling (rate limits для PAT и GitHub App, Conditional requests/ETag), webhooks через туннель, GitHub Events API. Рекомендация с цифрами лимитов.
- Draft PR: создание, перевод в ready, merge методы через API, авторазрешение «closes #N».
Результат: .scratch/auto-dev/research/03-github-deps-subissues-events.md с ссылками на docs.github.com.

## Answer

Полный отчёт: [research/03-github-deps-subissues-events.md](../research/03-github-deps-subissues-events.md).

- Нативные зависимости issues: GA, REST `.../issues/{n}/dependencies/blocked_by`, `gh issue create/edit --blocked-by/--blocking` (gh >= 2.94), до 50 связей. Работают в личных репо (публичный проверен, приватный не подтверждён). Готовность задачи = `state == open && issue_dependencies_summary.blocked_by == 0` (считает только открытые блокеры).
- Sub-issues: до 100 на родителя, 8 уровней, `sub_issues_summary {total, completed, percent_completed}`, работают в личных репо.
- Milestones: только через `gh api`; «всё закрыто» = `open_issues == 0`.
- Issue types только для организаций: использовать labels.
- Наблюдение за комментариями без публичного IP: polling двух репо-уровневых endpoint (`issues/comments?sort=updated&since=`, `issues?sort=updated&since=`) + `pulls/comments` с ETag (304 лимит не тратит). Каждые 15-20 с укладывается в 5000/ч. Events API непригоден (задержка). Secondary limits важнее: 80 записей/мин, 500/ч, запросы к записи последовательно, 1 с между ними.
- Draft PR: в приватных репо только на Team/Enterprise. Для личного приватного репо draft недоступен: нужна замена (обычный PR + label или заголовок WIP). Ready: GraphQL / `gh pr ready`. Merge: `PUT .../merge` или `merge-async`. `closes #N` закрывает только при merge в default branch.
- GitHub App даёт отличимого бота (`user.type == "Bot"`, `performed_via_github_app`); с PAT комментарии бота неотличимы от владельца. Права: Issues write, Pull requests write, Contents write (нужен для merge), Metadata read.
