# Стадия merge: метод слияния, конфликты, CI, закрытие issue и milestone

Type: grilling
Status: open
Blocked by: 06

## Question

Что делает merge-агент: метод (squash / merge / rebase), что если main ушёл вперёд (rebase worktree и повторный QA или нет), как резолвит конфликты и когда эскалирует человеку, нужно ли ждать CI, кто закрывает issue (авто через closes #N или агент), когда и кто закрывает milestone, что происходит с worktree и веткой после merge.

## Notes

- Из research 03: draft PR в приватном личном репо недоступен (только Team/Enterprise): решить замену (обычный PR + label/WIP-заголовок). Merge через `PUT .../merge` (merge/squash/rebase) или `merge-async`; `closes #N` срабатывает только при merge в default branch; токену нужен Contents write.
- Из тикета 06: issue закрывает GitHub через `Closes #N` в теле PR (тело пишет оркестратор при создании PR); после merge оркестратор снимает метку `auto-dev:*` и чистит рантайм; milestone закрывает оркестратор при `open_issues == 0`; PR, закрытый человеком без merge, переводит задачу в failed.
- Референс Breedly/breedly-ios (sandcastle/main.ts): ветка на тикет, implement -> verify (ступень по метке тикета, выбирает драйвер, не агент) -> review со структурированным вердиктом {approved, summary, blockers[{where, what}]} -> до N попыток починки -> merge в main -> закрыть тикет комментарием и снять `ready-for-agent`; прогон, закрывший последнюю задачу вехи, закрывает зонтик, спеку и саму веху; веха с любым другим открытым тикетом не закрывается. Задачи приёмки у нас нет (решение по 06). Красный тикет: комментарий с причиной, `ready-for-agent` снимается, ставится `ready-for-human`; если красна оснастка (infrastructure), `ready-for-agent` остаётся. Упор в лимит: тикет не помечается, цикл просто останавливается.
- Из контракта breedly-api: при закрытии Задачи отмечать соответствующие критерии закрытия в Epic (чек-лист в теле Epic); milestone закрывать, когда закрыты все issues вехи и все критерии Epic отмечены, тогда же закрывать Epic и Spec.
