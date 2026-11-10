import { LINK } from "./ui.js";

// The repository permissions the Installation needs, as GitHub names them in the token template URL.
const TOKEN_PERMISSIONS = {
  issues: "write",
  pull_requests: "write",
  contents: "write",
  actions: "read",
  statuses: "read",
  metadata: "read",
} as const;

const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
// GitHub caps the token name at 40 characters and the lifetime at 366 days.
const NAME_LIMIT = 40;
const LIFETIME_DAYS = 366;

// A link to GitHub's fine-grained token form with the name, owner, lifetime and permissions filled in.
// The form cannot preselect a repository: the human still picks "Only select repositories" and the Product.
export function githubTokenUrl(repo: string | null | undefined): string {
  const params = new URLSearchParams();
  const match = REPO.exec(repo?.trim() ?? "");
  params.set("name", (match ? `auto-dev ${match[0]}` : "auto-dev").slice(0, NAME_LIMIT));
  params.set("description", match ? `auto-dev Installation for ${match[0]}` : "auto-dev Installation");
  if (match) params.set("target_name", match[1]!);
  params.set("expires_in", String(LIFETIME_DAYS));
  for (const [permission, level] of Object.entries(TOKEN_PERMISSIONS)) params.set(permission, level);
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

export function GithubTokenHelp({ repo }: { repo: string | null | undefined }) {
  return (
    <details className="text-sm text-muted" data-testid="github-token-help">
      <summary className="cursor-pointer select-none">Как создать токен на GitHub</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>
          Откройте{" "}
          <a href={githubTokenUrl(repo)} target="_blank" rel="noreferrer" className={LINK}>
            форму нового fine-grained токена
          </a>
          : имя, срок 366 дней и права уже заполнены по ссылке.
        </li>
        <li>
          <b>Resource owner</b>: владелец репозитория Продукта. Если это организация, выберите её в списке заново, даже если она уже показана: иначе GitHub может создать токен на личный аккаунт.
        </li>
        <li>
          <b>Repository access</b>: Only select repositories, затем репозиторий Продукта.
        </li>
        <li>
          Проверьте <b>Repository permissions</b>: Issues, Pull requests, Contents: Read and write; Actions, Commit statuses, Metadata: Read-only.
        </li>
        <li>
          <b>Generate token</b> и вставьте значение <code>github_pat_…</code> сюда. GitHub показывает его один раз.
        </li>
      </ol>
      <p className="mt-2">Когда срок токена истечёт, новый вводится в Настройках, мастер повторять не нужно.</p>
    </details>
  );
}
