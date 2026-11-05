# Claude Code под подпиской Max на headless Linux VM: auth, режимы, политика, лимиты

Дата исследования: 2026-11-04. Источники только первичные: code.claude.com/docs, support.claude.com, anthropic.com/legal, claude.com/pricing, github.com/anthropics. Всё, что не удалось подтвердить первичным источником, помечено как "не подтверждено".

## Выводы для auto-dev

1. Официально поддерживаемый путь для headless под Max: на локальной машине с браузером выполнить `claude setup-token`, полученный годовой OAuth token положить на VM в `CLAUDE_CODE_OAUTH_TOKEN`. Документация прямо называет этот сценарий: "For CI pipelines, scripts, or other environments where interactive browser login isn't available" и "This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan". https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
2. Альтернатива без setup-token: `claude auth login` прямо на VM по SSH, URL открыть в локальном браузере, код вставить в stdin. Это тоже задокументированный flow (не device-code, а "paste code"). https://code.claude.com/docs/en/troubleshoot-install#oauth-login-fails-in-wsl2-ssh-or-containers
3. Копирование `~/.claude/.credentials.json` между машинами как способ auth в документации не описано: файл управляется через `/login` и `/logout`; задокументировано только сохранение каталога `~/.claude` через volume в devcontainer. Статус: технически файл на Linux хранится в plaintext `0600`, но перенос не является описанным способом, "не подтверждено" как официальный. https://code.claude.com/docs/en/authentication#credential-management
4. `claude -p` с `--output-format stream-json`, `--input-format stream-json`, `--resume`, `--session-id`, hooks, MCP (`--mcp-config`) работают под subscription OAuth: ни одна из этих страниц не ограничивает их API-ключом, а precedence auth явно включает `CLAUDE_CODE_OAUTH_TOKEN` и `/login`. Единственное исключение: `--bare` не читает OAuth, только `ANTHROPIC_API_KEY`/`apiKeyHelper`. https://code.claude.com/docs/en/headless#start-faster-with-bare-mode
5. Agent SDK (TypeScript) технически работает на subscription token: `CLAUDE_CODE_OAUTH_TOKEN` описан как "Alternative to /login for SDK and automated environments", и env/apiKeyHelper "apply to the CLI and the surfaces that wrap it, including ... the Agent SDK". https://code.claude.com/docs/en/env-vars , https://code.claude.com/docs/en/authentication#credential-management
6. Юридически: для собственного индивидуального использования (свой аккаунт, своя VM, свои задачи) Claude Code под Max допустим, Anthropic сам говорит "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK". Нельзя: отдавать свой логин/лимиты другим пользователям, строить продукт для третьих лиц на subscription login, хранить/проксировать чужие claude.ai credentials. https://code.claude.com/docs/en/legal-and-compliance#usage-policy
7. Серая зона: Consumer Terms запрещают "automated or non-human means" доступ, кроме API key или "where we otherwise explicitly permit it". Документация Claude Code (setup-token "for CI pipelines, scripts", GitHub Actions с `CLAUDE_CODE_OAUTH_TOKEN`) и есть такое явное разрешение для автоматизации Claude Code под подпиской. Но для SDK-продукта Anthropic прямо говорит: "Developers building products or services ... including those using the Agent SDK, should use API key authentication". Для personal-автоматизации auto-dev это допустимо, для сервиса на других людей - нет. https://www.anthropic.com/legal/consumer-terms , https://code.claude.com/docs/en/agent-sdk/overview
8. Лимиты: Max = 5x Pro каждые 5 часов и каждую неделю; Ultra (бывший Max 20x) = 10x Pro в неделю, без 5-часового лимита для verified аккаунтов. Лимиты общие для claude.ai и Claude Code. Явного капа на число параллельных сессий в источниках нет (не подтверждено), но каждая сессия жжёт общий пул. https://claude.com/pricing , https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
9. Детект исчерпания лимита программно: в stream-json приходит `rate_limit_event` с `rate_limit_info.status: "rejected"`, `resetsAt`, `utilization`; в результате `result` с `is_error: true` и `api_error_status`; текст "You've hit your session limit · resets ...". `-p` при ошибке внутри run печатает её как result на stdout и завершается non-zero. Остаточный usage: `rate_limits.five_hour/seven_day.used_percentage` и `resets_at` в JSON statusline (только для Pro/Max/Ultra, после первого API-ответа). Отдельного CLI/JSON API для "сколько осталось" нет (не подтверждено). https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent , https://code.claude.com/docs/en/statusline#rate-limit-usage
10. Для unattended-сервиса: `--dangerously-skip-permissions` отказывается стартовать под root/sudo (нужен non-root user), либо `--permission-mode auto --permission-prompts none`; для долгих ожиданий лимита `CLAUDE_CODE_RETRY_WATCHDOG=1`. Automatic "wait and continue" при лимите в `-p` недоступен. https://code.claude.com/docs/en/permission-modes , https://code.claude.com/docs/en/env-vars , https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset

## 1. Headless auth без браузера

### 1.1 `claude auth login` / `/login` на машине без браузера

- Нормальный flow: "Claude Code opens a browser window for you to log in on first launch". "If the browser doesn't open automatically, press `c` to copy the login URL to your clipboard, then paste it into your browser. If your browser shows a login code instead of redirecting back after you sign in, paste it into the terminal at the `Paste code here if prompted` prompt." https://code.claude.com/docs/en/authentication#log-in-to-claude-code
- Для SSH/контейнеров задокументирован именно "paste code" flow: "Sign in through the separate login URL that the terminal shows above its paste prompt ... Open the URL in a browser on your local machine and sign in. The browser then shows a code instead of returning to `localhost`. Paste that code into the terminal at the prompt that begins `Paste code here`." И "use `claude auth login` instead, which reads the pasted code from standard input". https://code.claude.com/docs/en/troubleshoot-install#oauth-login-fails-in-wsl2-ssh-or-containers
- `claude auth login`: "Sign in to your Anthropic account. Use `--email` to pre-fill your email address, `--sso` to force SSO authentication, and `--console` to sign in with Anthropic Console for API usage billing instead of a Claude subscription". `claude auth status`: "Show authentication status as JSON ... Exits with code 0 if logged in, 1 if not ... `authMethod` field is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, or `third_party`". https://code.claude.com/docs/en/cli-reference#cli-commands
- Если вы выполнили `claude auth login` до первой сессии, интерактивный login prompt пропускается: "you ran `claude auth login` in your shell before your first session". https://code.claude.com/docs/en/authentication#log-in-to-claude-code
- Device-code flow (RFC 8628, ввод кода на отдельной странице) в документации не упоминается: не подтверждено. Задокументирован только URL + paste code.
- `/login` в `-p` не работает: "Built-in commands that only run in the terminal interface, such as `/login`, aren't available." https://code.claude.com/docs/en/headless#create-a-commit

### 1.2 `claude setup-token` и `CLAUDE_CODE_OAUTH_TOKEN` (основной способ для VM)

- "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`. The command opens the same browser authorization flow as `/login`, and the token prints to the terminal after you approve access in the browser. It does not save the token anywhere; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate". https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- "This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan. It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors. MCP servers you configure locally still work." https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`. If your script passes `--bare`, authenticate with `ANTHROPIC_API_KEY` or an `apiKeyHelper` instead." https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- CLI reference: "`claude setup-token` | Generate a long-lived OAuth token for CI and scripts. Prints the token to the terminal without saving it. Requires a Claude subscription." https://code.claude.com/docs/en/cli-reference#cli-commands
- Env var: "`CLAUDE_CODE_OAUTH_TOKEN` | OAuth access token for claude.ai authentication. Alternative to `/login` for SDK and automated environments. Ignored in project and local settings. Takes precedence over keychain-stored credentials. Generate one with `claude setup-token`." https://code.claude.com/docs/en/env-vars
- Precedence: пункт 5 в списке: "`CLAUDE_CODE_OAUTH_TOKEN` environment variable. A long-lived OAuth token generated by `claude setup-token`. Use this for CI pipelines and scripts where browser login isn't available." https://code.claude.com/docs/en/authentication#authentication-precedence
- Тот же токен официально используется в GitHub Actions: "`CLAUDE_CODE_OAUTH_TOKEN`: an OAuth token that authenticates with your Claude subscription, available on Pro, Max, Ultra, Team, and Enterprise plans. Generate one by running `claude setup-token` locally." И "If you authenticate with an OAuth token, runs use your Claude subscription instead of API billing." Важно: "an OAuth token is tied to the subscription of the person who ran `claude setup-token`". https://code.claude.com/docs/en/github-actions
- Codespaces: "To carry authentication across codespaces, store `ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` as a Codespaces secret." https://code.claude.com/docs/en/devcontainer#persist-authentication-and-settings-across-rebuilds
- Известный баг истории (исправлен): "Fixed a transient 401 replacing a long-lived `CLAUDE_CODE_OAUTH_TOKEN` with a stored login's short-lived token, breaking headless sessions until restart". https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Ограничение setup-token под managed settings: "`claude setup-token` and `/install-github-app`: enforce only `forceLoginMethod`, so they can mint a token in a different organization". Для личного Max не актуально. https://code.claude.com/docs/en/authentication#restrict-login-to-your-organization

### 1.3 Копирование credentials-файла / keychain

- Хранение: "On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`." На macOS в Keychain; при заблокированном Keychain (SSH) падает в тот же `~/.claude/.credentials.json`. https://code.claude.com/docs/en/authentication#credential-management
- "If you've set the `CLAUDE_CONFIG_DIR` environment variable, Claude Code keeps the `.credentials.json` file under that directory instead". https://code.claude.com/docs/en/authentication#credential-management
- "Claude Code manages `.credentials.json` through `/login` and `/logout`." Ручной перенос файла между машинами не описан. https://code.claude.com/docs/en/authentication#credential-management
- Единственный задокументированный способ "сохранить логин вне сессии" это persist каталога: "Claude Code stores its authentication token, user settings, and session history under the `~/.claude` directory ... To keep the directory and the file, mount a named volume at `~/.claude` and set `CLAUDE_CONFIG_DIR` to the same path". https://code.claude.com/docs/en/devcontainer#persist-authentication-and-settings-across-rebuilds
- Login из `/login` истекает и обновляется: "When the login you created with `/login` is within three days of expiring, Claude Code shows a warning at startup ... Once the stored login expires and can't be refreshed, each model request fails with `Login expired · Please run /login`". "Renewing early matters most for sessions that run unattended." https://code.claude.com/docs/en/authentication#renew-an-expiring-login
- Параллельные процессы на одной машине делят один логин: "Parallel sessions on one machine share a saved login and coordinate its renewal so that only one process refreshes the token at a time." https://code.claude.com/docs/en/troubleshoot-install#not-logged-in-or-token-expired
- Вывод: копирование `.credentials.json` на VM формально не описано как поддерживаемый способ (не подтверждено). Поддерживаемые: `CLAUDE_CODE_OAUTH_TOKEN` (годовой) и `claude auth login` с paste code (короткоживущий, авто-refresh).

### 1.4 Несколько аккаунтов

- "give each account its own configuration directory ... set the `CLAUDE_CONFIG_DIR` environment variable ... Each directory has its own settings, session history, and claude.ai login or API key." https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts

## 2. Что работает под Max в headless/SDK

### 2.1 `claude -p` и флаги

- `-p` работает с любой credential из precedence-списка; про API key сказано только: "In non-interactive mode (`-p`), the key is always used when present." Значит без `ANTHROPIC_API_KEY` в окружении `-p` использует OAuth token / subscription login. https://code.claude.com/docs/en/authentication#authentication-precedence
- Исключение только `--bare`: "In bare mode, Claude Code never reads OAuth credentials or the system keychain. For the Anthropic API, set `ANTHROPIC_API_KEY`". И предупреждение: "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." Это риск для auto-dev: если `--bare` станет default для `-p`, subscription auth в `-p` перестанет работать без явного отключения bare. https://code.claude.com/docs/en/headless#start-faster-with-bare-mode
- `--output-format`: "`text` (default) ... `json`: structured JSON with result, session ID, and metadata ... `stream-json`: newline-delimited JSON for real-time streaming". Для стрима: "Use `--output-format stream-json` with `--verbose` and `--include-partial-messages`". https://code.claude.com/docs/en/headless#get-structured-output
- `--input-format`: "Specify input format for print mode (options: `text`, `stream-json`)", пример `claude -p --input-format stream-json --output-format stream-json --verbose`. https://code.claude.com/docs/en/cli-reference#cli-flags
- `--replay-user-messages`: "Re-emit user messages from stdin back on stdout for acknowledgment. Requires `--input-format stream-json` and `--output-format stream-json`". https://code.claude.com/docs/en/cli-reference#cli-flags
- `--resume`: "Resume a specific session by ID or name ... In place of an ID, you can pass the absolute path to a session's `.jsonl` transcript file ... When you pass a session ID, Claude Code searches the current project directory and its git worktrees, then every other project on this machine." https://code.claude.com/docs/en/cli-reference#cli-flags
- `--session-id`: "Use a specific session ID for the conversation (must be a valid UUID)". `--fork-session`: "When resuming, create a new session ID instead of reusing the original". https://code.claude.com/docs/en/cli-reference#cli-flags
- `--continue` с `-p`: "`claude -p --continue` includes `-p`, SDK, and `/loop` sessions." https://code.claude.com/docs/en/cli-reference#cli-flags
- Пример multi-session: `session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')` затем `claude -p "Continue that review" --resume "$session_id"`. https://code.claude.com/docs/en/headless#continue-conversations
- Предостережение: "If you resume the same session in two terminals without forking, messages from both interleave into one transcript." https://code.claude.com/docs/en/sessions
- Ограничения `-p`: нельзя `--bg`; "Piped stdin is capped at 10MB"; `--max-turns`, `--max-budget-usd` только для print mode. https://code.claude.com/docs/en/headless#basic-usage , https://code.claude.com/docs/en/cli-reference#cli-flags
- Нигде на этих страницах нет привязки флагов к типу credential. Вывод: под Max все перечисленные флаги работают (кроме `--bare`).

### 2.2 Agent SDK (TypeScript) на subscription OAuth token

- Технически: "`apiKeyHelper`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` apply to the CLI and the surfaces that wrap it, including the VS Code extension, the Agent SDK, and GitHub Actions." https://code.claude.com/docs/en/authentication#credential-management
- "`CLAUDE_CODE_OAUTH_TOKEN` ... Alternative to `/login` for SDK and automated environments." https://code.claude.com/docs/en/env-vars
- Ошибка "Could not resolve authentication method": "Confirm `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or your cloud provider credentials are set in the environment that launches the worker". Это подтверждает, что SDK/worker принимает OAuth token как credential. https://code.claude.com/docs/en/errors#could-not-resolve-authentication-method
- SDK запускает тот же бинарник: "A library that runs the Claude Code binary, with Claude Code's capabilities, such as built-in tools, permissions, sessions, and hooks." https://code.claude.com/docs/en/agent-sdk/overview
- Опция `env` в TS SDK: "When set, this replaces the subprocess environment instead of merging with `process.env`, so pass `{ ...process.env, YOUR_VAR: 'value' }` to keep inherited variables like `PATH`." Токен надо прокидывать явно, если задаёте `env`. https://code.claude.com/docs/en/agent-sdk/typescript#options
- Опции сессий в SDK: `resume` ("Session ID to resume"), `continue`, `forkSession`, `sessionId` ("Use a specific UUID for the session instead of auto-generating one"), `resumeSessionAt`. https://code.claude.com/docs/en/agent-sdk/typescript#options
- SDK логины учитывают `forceLoginOrgUUID` ("Terminal, VS Code extension, and Agent SDK logins: verify `forceLoginOrgUUID` for claude.ai account logins"), то есть SDK явно умеет работать с claude.ai login. https://code.claude.com/docs/en/authentication#restrict-login-to-your-organization
- Документационно: quickstart и hosting описывают только `ANTHROPIC_API_KEY` и cloud providers; OAuth-token там не упомянут. https://code.claude.com/docs/en/agent-sdk/quickstart#setup , https://code.claude.com/docs/en/agent-sdk/hosting
- Политика (см. раздел 3): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." https://code.claude.com/docs/en/agent-sdk/overview

### 2.3 MCP и in-process SDK MCP

- CLI: "`--mcp-config` | Load MCP servers from JSON files or strings ... When you pass this flag with `-p`, Claude Code waits for still-pending servers to connect before running the first turn, up to the `MCP_TIMEOUT` startup timeout, 30 seconds by default". `--strict-mcp-config`: "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations." https://code.claude.com/docs/en/cli-reference#cli-flags
- Без `--bare` `-p` подхватывает `.mcp.json` проекта и hooks из `.claude/settings.json` даже в недоверенной папке: "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted. A `-p` session shows no workspace trust dialog and no per-server approval prompt." https://code.claude.com/docs/en/headless#start-faster-with-bare-mode
- Под `CLAUDE_CODE_OAUTH_TOKEN` локальные MCP работают, claude.ai connectors нет: "It can only make model requests, so it can't ... fetch claude.ai connectors. MCP servers you configure locally still work." https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- SDK MCP in-process: "Define custom tools directly in your application code instead of running a separate server process." "The server runs in-process inside your application, not as a separate process." Регистрация через `createSdkMcpServer` и `mcpServers` + `allowedTools: ["mcp__<server>__*"]`. https://code.claude.com/docs/en/agent-sdk/mcp#sdk-mcp-servers , https://code.claude.com/docs/en/agent-sdk/custom-tools
- Статус серверов в `system/init`: "`status` field can be `"pending"`, `"connected"`, `"failed"`, `"needs-auth"`, or `"disabled"`". https://code.claude.com/docs/en/agent-sdk/mcp#error-handling
- MCP OAuth в SDK не интерактивен: "The SDK doesn't open a browser or run an interactive OAuth flow." Нужно передавать токен в `headers` или залогиниться в интерактивной сессии на той же машине. https://code.claude.com/docs/en/agent-sdk/mcp#oauth2-authentication
- Ограничений по типу credential для MCP/SDK MCP нет. Вывод: работают под Max.

### 2.4 Hooks

- SDK: "callback hooks you pass in `options.hooks` and shell command hooks from settings files when the corresponding `settingSources` ... entry is enabled, which it is for default `query()` options." Таблица событий: `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart` (TS only), `SessionEnd` (TS only), `PermissionRequest`, `Notification` и др. https://code.claude.com/docs/en/agent-sdk/hooks#available-hooks
- CLI `-p`: `--include-hook-events` "Include hook lifecycle events in the output stream ... Requires `--output-format stream-json`". https://code.claude.com/docs/en/cli-reference#cli-flags
- `SessionEnd` выполняется при SIGTERM: "Claude Code then runs `SessionEnd` hooks and exits." https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm
- `Setup` hook для CI: "Fires only when you launch Claude Code with `--init-only`, or with `--init` or `--maintenance` in non-interactive mode with the `-p` flag." https://code.claude.com/docs/en/hooks
- Привязки к credential нет. Вывод: hooks работают под Max.

## 3. Политика Anthropic

### 3.1 Какие terms применяются

- "Your use of Claude Code is subject to: Commercial Terms of Service - for Team, Enterprise, and Claude API users; Consumer Terms of Service - for Free, Pro, Max, and Ultra users". https://code.claude.com/docs/en/legal-and-compliance#license
- Agent SDK: "Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service, including when you use it to power products and services that you make available to your own customers and end users". https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms , https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/README.md
- Consumer Terms (Effective Oct 8, 2025): "Our Commercial Terms of Service govern your use of any Anthropic API key, the Anthropic Console, or any other Anthropic offerings that reference the Commercial Terms of Service. For clarity, this does not include Claude.ai or Claude Pro use for individuals or entities." https://www.anthropic.com/legal/consumer-terms

### 3.2 Автоматизация и "non-human means"

- Consumer Terms, раздел 3 "Use of our Services", запрещено: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." https://www.anthropic.com/legal/consumer-terms
- Там же: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." и "You are responsible for all activity under the account through which you access the Services." https://www.anthropic.com/legal/consumer-terms
- Что Anthropic "explicitly permits" для Claude Code под подпиской (из официальной документации, а не из Terms):
  - setup-token "For CI pipelines, scripts, or other environments where interactive browser login isn't available ... This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan". https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
  - GitHub Actions на subscription token: "If you authenticate with an OAuth token, runs use your Claude subscription instead of API billing." Включая автоматический режим и cron-schedule ("Run on a schedule"). https://code.claude.com/docs/en/github-actions
  - Legal page: "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK." https://code.claude.com/docs/en/legal-and-compliance#acceptable-use
- Это интерпретация: собственные скрипты/агенты на своём аккаунте для собственных задач попадают под "where we otherwise explicitly permit it" через документацию Claude Code; прямой фразы "automated background agents under Max are allowed" в Terms нет (не подтверждено дословно).

### 3.3 OAuth vs API key: кому что

- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
- "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens: sign-in to a Claude account must complete through Anthropic's own flow." https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
- "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice." https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
- Agent SDK overview и quickstart, одинаковая NOTE: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead." https://code.claude.com/docs/en/agent-sdk/overview , https://code.claude.com/docs/en/agent-sdk/quickstart
- Условия для хостинга Claude Code в чужих продуктах: "The Claude Code binary must not be modified ... Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential". https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products

### 3.4 Usage Policy

- Запрещено: "Resell, proxy, or otherwise provide access to Claude through unauthorized means"; "Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products"; "Circumvent a ban through the use of a different account"; "create multiple accounts, to avoid detection". https://www.anthropic.com/legal/aup
- "Agentic use cases" должны соответствовать политике; пользователь отвечает за агентов, которых разворачивает. https://www.anthropic.com/legal/aup
- Enforcement: "we may warn you or throttle, limit, suspend, or terminate your access to our products and services". https://www.anthropic.com/legal/aup
- Про concurrent sessions, число параллельных агентов и "background runs" ни Consumer Terms, ни AUP, ни support-статьи ничего не говорят: не подтверждено (ни запрет, ни разрешение).

### 3.5 Итог по политике для auto-dev

- Разрешено (по документации): свой Max, свой `claude setup-token`, свой VM, свои задачи, unmodified бинарник, `claude -p`/SDK как оркестрация собственной работы.
- Запрещено: давать доступ другим людям через свой токен, продукт для третьих лиц на subscription login, хранить/проксировать чужие claude.ai токены, несколько аккаунтов ради обхода лимитов, модификация бинарника/обход guardrails.
- Риск: "Advertised usage limits ... assume ordinary, individual usage"; Anthropic может применять меры "without prior notice". Тяжёлая круглосуточная автоматизация под персональным планом формально не запрещена, но и не является "ordinary individual usage" по духу.

## 4. Лимиты

### 4.1 Тарифы и окна

- Pricing: Max ($100/mo) "5x Pro usage every 5 hours and every week"; Ultra ($200/mo) "No 5-hour limit" (для verified аккаунтов) и "10x Pro usage every week". Claude Code включён в оба. https://claude.com/pricing
- "The Max 20x plan is now called the Ultra plan." "Get 10 times the Pro plan's usage every week." "Verified Ultra accounts don't have a five-hour limit." https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan
- Max: "five times the Pro plan's usage every five hours and every week"; "a weekly usage limit that applies across all models" и "a separate weekly limit for Fable"; "Additional usage limits may apply to manage capacity and ensure fair access to all users." https://support.claude.com/en/articles/11049741-what-is-the-max-plan
- "These limits are shared across Claude and Claude Code, meaning all activity in both tools counts against the same limits." "Pro and Max plans have a five-hour session limit and a weekly limit." https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- 5-часовое окно: "The period starts when you send your first message, and your limit resets in full five hours later." Недельное: "Weekly limits reset at a fixed time each week that is assigned to your account." https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
- Включённые в Max/Ultra месячные API credits в Claude Code не работают: "Monthly API credits included with the Max plan can't be used in Claude Code or the Claude apps, including for usage credits." https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Usage credits (pay-as-you-go после лимита): "Usage credits apply to both Claude conversations and Claude Code terminal usage." "Usage credits are billed at standard API rates." Включаются в Settings > Usage; в CLI команда `/usage-credits`. https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans , https://code.claude.com/docs/en/costs#add-usage-credits-to-your-subscription
- Ни одна из страниц не называет конкретные числа токенов/сообщений в окне: не подтверждено.

### 4.2 Параллельные сессии

- Явный кап на число одновременных сессий ни в docs, ни в support, ни в Terms не найден: не подтверждено.
- Косвенно: "Usage counts against the session and weekly allowances at the same time. A single burst of heavy activity, such as a large workflow fanout, can exhaust the weekly allowance before the session window resets." https://code.claude.com/docs/en/errors#youve-hit-your-session-limit
- "Agent teams use approximately 7x more tokens than standard sessions"; "Each active teammate continues consuming tokens until it exits". https://code.claude.com/docs/en/costs#agent-team-token-costs
- "Per-developer costs vary widely based on model selection, codebase size, and usage patterns such as running multiple instances or automation." https://code.claude.com/docs/en/costs
- Хостинг SDK: "Each session runs in its own subprocess, so concurrency on a host is bounded by how many subprocesses its RAM can hold." (технический, не тарифный лимит). https://code.claude.com/docs/en/agent-sdk/hosting#scaling-and-concurrency

### 4.3 Что происходит при исчерпании

- Сообщения: "You've hit your session limit · resets 3:45pm", "You've hit your weekly limit · resets Mon 12:00am", "You've hit your Opus limit · resets 3:45pm". "Claude Code blocks further requests until the reset time shown in the message. The session and weekly limits are shared across all models, so switching models doesn't restore access." https://code.claude.com/docs/en/errors#youve-hit-your-session-limit
- Предупреждение заранее: "`You've used 85% of your session limit · resets 3:45pm`". https://code.claude.com/docs/en/errors#youve-hit-your-session-limit
- Новые версии переименовали: "Changed usage limit messages to call the 5-hour window the "5-hour limit" instead of the "session limit"". https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- "Wrapping up": "Usage limit reached · wrapping up" - небольшой capped allowance, чтобы закончить текущий шаг; для Max применяется при каждом 5-часовом лимите в рамках недельного. https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Автоожидание сброса только в интерактиве: "Automatic continue is on by default in interactive sessions signed in with a claude.ai subscription." "Claude Code doesn't offer the wait at all in these cases: Background sessions and `-p` runs: the menu row isn't available." Настройка `autoContinueAtUsageLimit`. https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset , https://code.claude.com/docs/en/settings-reference#autocontinueatusagelimit
- Для unattended ожидания есть `CLAUDE_CODE_RETRY_WATCHDOG=1`: "Retries `429` and `529` capacity errors indefinitely ... The watchdog backs off up to 5 minutes between attempts, or until the limit resets when the response carries a rate-limit reset time, so a session that hits a usage limit waits out the remaining window." Но: "Claude Code fails at once when a standard-speed request gets a `429` that reports a spend limit or exhausted usage credits". Доп. `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`, `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` (от 60000 до 10800000 мс; только для claude.ai session/weekly limit). https://code.claude.com/docs/en/env-vars
- Транзиентный 429 отличается от лимита: "API Error: Server is temporarily limiting requests (not your usage limit)" ретраится автоматически; для подписчиков "Transient server rate-limit errors (429s unrelated to your usage limit) are now retried automatically with backoff for subscribers". https://code.claude.com/docs/en/errors#server-is-temporarily-limiting-requests , https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

### 4.4 Программный детект в `-p` / stream-json / SDK

- Событие в stream-json/SDK: 
  ```
  type SDKRateLimitEvent = {
    type: "rate_limit_event";
    rate_limit_info: {
      status: "allowed" | "allowed_warning" | "rejected";
      resetsAt?: number;
      utilization?: number;
      errorCode?: "credits_required";
      canUserPurchaseCredits?: boolean;
      hasChargeableSavedPaymentMethod?: boolean;
    };
    uuid: UUID; session_id: string;
  };
  ```
  "When `errorCode` is `"credits_required"`, the rejection is from a claude.ai subscription whose included usage is exhausted, and the session cannot continue until the user buys usage credits." Requires v2.1.181+. https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent
- CHANGELOG подтверждает, что событие идёт в headless: "Improved headless `rate_limit_event` usage-limit warnings to say whether the account has extra usage turned on". https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Retry-событие: `system/api_retry` с полями `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (HTTP), `error` из набора `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `rate_limit`, `overloaded`, ... https://code.claude.com/docs/en/headless#handle-api-retries
- Ошибка в assistant-сообщении: `SDKAssistantMessageError` включает `'rate_limit'` ("a 429 against your quota") и `'overloaded'` ("the API returned a 529"). https://code.claude.com/docs/en/agent-sdk/typescript#sdkassistantmessage
- Финальный `result`: поля `is_error: boolean`, `api_error_status?: number | null` ("the HTTP status code of the API error that terminated the conversation"), `subtype` `success` | `error_max_turns` | `error_during_execution` | `error_max_budget_usd` | `error_max_structured_output_retries`, `errors: string[]`, `permission_denials`, `total_cost_usd`, `usage`, `modelUsage`. https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage
- Exit code `-p`: "Claude Code exits with code 0 on success and a non-zero code when the run fails ... When a failure happens inside the run, such as missing authentication, Claude Code prints the failure as the result on stdout." SIGTERM даёт 143. https://code.claude.com/docs/en/headless#basic-usage , https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm
- SDK при non-zero exit: TS "surfaces a nonzero CLI exit as a plain `Error` that rejects the `for await` loop"; если CLI вернул error result до выхода: "Claude Code returned an error result: <the CLI's own error report>". https://code.claude.com/docs/en/agent-sdk/troubleshooting#cli-process-exit
- Прямого утверждения "при usage limit `-p` завершается с кодом N" в документации нет: не подтверждено. Надёжный детект: `rate_limit_event.status == "rejected"` + `result.is_error` + `api_error_status` + текст `You've hit your ... limit`.
- Auth-ошибки в `-p`/SDK (текст): "Failed to authenticate: OAuth session expired and could not be refreshed" (код `authentication_failed`), "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator." https://code.claude.com/docs/en/errors#login-expired , https://code.claude.com/docs/en/errors#oauth-token-revoked-or-expired
- В новых версиях при истёкшем логине `-p` подсказывает `claude auth login` и `claude setup-token`. https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

### 4.5 Остаток usage: `/usage`, `/status`, JSON

- `/usage`: "Show session cost, plan usage limits, and activity stats." Алиасы `/cost`, `/stats`. "Subscribers see plan usage bars, activity stats, and a usage breakdown on the same screen." Данные "computed from local session history on this machine, so usage from other devices or claude.ai is not included" (для breakdown), а бары лимитов запрашиваются с usage endpoint, который может быть rate limited ("Showing last-known usage"). https://code.claude.com/docs/en/commands , https://code.claude.com/docs/en/costs#using-the-usage-command
- В `-p` вывод `/usage` приходит как assistant-сообщение: "When you send a command such as `/context` or `/usage` as a prompt, its output arrives as an `SDKAssistantMessage`." Структурированного JSON для этого нет. https://code.claude.com/docs/en/agent-sdk/typescript#sdklocalcommandoutputmessage
- `/status`: "showing version, model, account, and connectivity"; есть строка `Login` с "Expired" (v2.1.210+). https://code.claude.com/docs/en/commands , https://code.claude.com/docs/en/authentication#renew-an-expiring-login
- `claude auth status` даёт JSON по auth (не по лимитам): `authMethod`, `configDirectory`, exit 0/1. https://code.claude.com/docs/en/cli-reference#cli-commands
- Единственный машинно-читаемый источник остатка лимитов: JSON statusline. "`rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` | Percentage of the 5-hour or 7-day rate limit consumed, from 0 to 100"; "`rate_limits.five_hour.resets_at`, `rate_limits.seven_day.resets_at` | Unix epoch seconds". "`rate_limits`: appears only for claude.ai Pro, Max, and Ultra subscribers ... it appears only after the first API response in the session." https://code.claude.com/docs/en/statusline#rate-limit-usage
- Отдельного публичного API/CLI-команды "remaining usage в JSON" нет: не подтверждено.
- `--output-format json` даёт `total_cost_usd` и per-model breakdown, но это client-side оценка в долларах, не доля плана. https://code.claude.com/docs/en/headless#pipe-data-through-claude

## 5. Запуск как system service / unattended

### 5.1 Permissions

- `--dangerously-skip-permissions`: "Skip permission prompts. Equivalent to `--permission-mode bypassPermissions`." https://code.claude.com/docs/en/cli-reference#cli-flags
- Root-ограничение: "On Linux and macOS, Claude Code refuses to start in `bypassPermissions` mode when running as root or under `sudo`: `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`. The check is skipped automatically inside a recognized sandbox. To run autonomously in a container, use the dev container configuration, which runs Claude Code as a non-root user." Для systemd: `User=` не root. https://code.claude.com/docs/en/permission-modes
- "Only use this mode in isolated environments like containers, VMs, or dev containers without internet access, where Claude Code cannot damage your host system." https://code.claude.com/docs/en/permission-modes
- Фоновые сессии (`--bg`) требуют `"skipDangerousModePermissionPrompt": true` в `~/.claude/settings.json`, иначе bypass игнорируется. https://code.claude.com/docs/en/permission-modes#bypass-permissions-ignored-in-a-background-session
- `--permission-mode`: "Accepts `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, or `manual`". https://code.claude.com/docs/en/cli-reference#cli-flags
- Стартовый режим `-p`: "In Claude Code v2.1.302 or later, `claude -p` and Agent SDK runs with no permission mode set start in Manual mode ... Calls needing approval are denied unless you approve them with an allow rule, hook, `canUseTool` callback, or `--permission-prompt-tool`." https://code.claude.com/docs/en/permission-modes
- Рекомендуемый unattended-вариант без bypass: `claude -p "..." --permission-mode auto --permission-prompts none`. "`--permission-prompts none` ... Anything that would prompt is denied unless a `PermissionRequest` hook allows it, Claude is told that nobody can approve the request and not to retry it ... With `--output-format stream-json`, denials appear as `permission_denied` system messages, and the final result message lists them in `permission_denials`." Requires v2.1.259+. https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs
- `--allowedTools "Bash,Read,Edit"` для точечного allow. https://code.claude.com/docs/en/headless#auto-approve-tools
- SDK: `permissionMode: 'bypassPermissions'` требует `allowDangerouslySkipPermissions: true`; `permissionPrompts: 'none'`; `canUseTool` callback. https://code.claude.com/docs/en/agent-sdk/typescript#options

### 5.2 Поведение процесса под supervisor

- SIGTERM: "Claude Code exits with code 143. Claude Code leaves the turn that was in progress unfinished ... To end the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`, before you stop the process." https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm
- `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`: "automatically resume if the previous session ended mid-turn. Used in SDK mode". https://code.claude.com/docs/en/env-vars
- Фоновая работа после последнего turn: "stops whatever is still running after 10 minutes of continuous idle waiting by default"; `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`. https://code.claude.com/docs/en/headless#background-tasks-at-exit
- Удалённая рабочая папка: сессия продолжается, в stream-json приходит warning. https://code.claude.com/docs/en/headless#if-the-working-directory-is-deleted
- Истёкший логин в unattended-сессии: "A background session ... that outlives the login stops making progress once the credential expires and can't recover until you sign in again." Поэтому для сервиса предпочтителен годовой `CLAUDE_CODE_OAUTH_TOKEN`. https://code.claude.com/docs/en/authentication#renew-an-expiring-login

### 5.3 Переменные окружения, которые важны

- Precedence credentials (сверху вниз): 1) cloud provider (`CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`), 2) `ANTHROPIC_AUTH_TOKEN` (Bearer), 3) `ANTHROPIC_API_KEY` (X-Api-Key; "In non-interactive mode (`-p`), the key is always used when present"), 4) `apiKeyHelper`, 5) `CLAUDE_CODE_OAUTH_TOKEN`, 6) Anthropic profile / WIF, 7) subscription OAuth из `/login`. https://code.claude.com/docs/en/authentication#authentication-precedence
- Следствие: любой `ANTHROPIC_API_KEY` в окружении сервиса молча переключит `-p` на API-биллинг: "`ANTHROPIC_API_KEY` ... When set, this key is used instead of your Claude Pro, Max, Ultra, Team, or Enterprise subscription even if you are logged in. In non-interactive mode (`-p`), the key is always used when present." https://code.claude.com/docs/en/env-vars
- Support-статья подтверждает: `ANTHROPIC_API_KEY` в окружении "overrides subscription authentication and triggers API charges". https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- `CLAUDE_CODE_OAUTH_TOKEN`: "Ignored in project and local settings" (нельзя задать через `.claude/settings.json` проекта; через env сервиса или user/managed settings можно). "Unless you run `/login`, Claude Code uses the token you set for the whole session". https://code.claude.com/docs/en/env-vars
- `CLAUDE_CONFIG_DIR`: "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path." Удобно для systemd-юнита с отдельным HOME. https://code.claude.com/docs/en/env-vars
- `CLAUDE_CODE_RETRY_WATCHDOG=1` "for unattended sessions such as eval harnesses, CI jobs, or remote workers" (см. 4.3). https://code.claude.com/docs/en/env-vars
- `CLAUDE_CODE_MAX_RETRIES` (default 10, cap 15 без watchdog). https://code.claude.com/docs/en/env-vars
- `DISABLE_AUTOUPDATER=1` "disable automatic background updates"; `DISABLE_UPDATES=1` блокирует и ручные. https://code.claude.com/docs/en/env-vars
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` отключает auto-updates/telemetry, но также feature-flag fetching, что ломает Remote Control и, по 4.3, usage-limit recheck в watchdog. https://code.claude.com/docs/en/env-vars
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` убирает `run_in_background`. https://code.claude.com/docs/en/env-vars
- `MCP_TIMEOUT` (30 с по умолчанию) для ожидания MCP при `-p --mcp-config`. https://code.claude.com/docs/en/cli-reference#cli-flags
- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `CLAUDE_CODE_RESUME_PROMPT`. https://code.claude.com/docs/en/env-vars
- Под managed settings `forceLoginMethod`/`forceLoginOrgUUID` могут блокировать `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper`: для личного Max неактуально. https://code.claude.com/docs/en/authentication#restrict-login-to-your-organization

### 5.4 Что НЕ работает под `CLAUDE_CODE_OAUTH_TOKEN`

- Remote Control и claude.ai connectors ("It can only make model requests"). https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- `/schedule` (routines) и connectors требуют claude.ai login, а не profile/token-источника. https://code.claude.com/docs/en/authentication#anthropic-profiles-and-federation-credentials
- `--bare`. https://code.claude.com/docs/en/headless#start-faster-with-bare-mode
- Автоожидание сброса лимита (только интерактив). https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset

## Открытые вопросы (не подтверждено первичными источниками)

- Точный лимит токенов/сообщений в 5-часовом и недельном окне Max.
- Существует ли серверный кап на число одновременных сессий/запросов для одного subscription-аккаунта.
- Exit code `claude -p` именно при usage-limit rejection (документирован только общий "non-zero when the run fails").
- Официальная допустимость переноса `~/.claude/.credentials.json` между машинами.
- Поведение после смены default `-p` на `--bare` (анонсировано, дата не названа).
