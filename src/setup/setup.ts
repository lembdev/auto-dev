import { createHash } from "node:crypto";
import { ConfigError, cloneUrlOf, type GitHubConfig } from "../config.js";
import { ENV_KEYS, type ConfigStore } from "../config-store.js";
import type { InstallationStore } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { DriverPort, SmokeQueryResult } from "../ports/driver.js";
import { GitHubError, missingPermissions, type GitHubPort, type RepositoryAccess, type RepositoryPermission } from "../ports/github.js";
import type { WorktreePort } from "../ports/worktree.js";
import { hashPassword as argonHash } from "../server/auth.js";

// Steps of the first-run wizard, in the order the human walks them.
export const SETUP_STEPS = ["password", "repository", "access", "oauth", "smoke", "clone"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export type SetupStatus = {
  // True while any step is undone; the UI shows the wizard instead of the dashboard.
  required: boolean;
  // First step still to do, resumed after a restart.
  current: SetupStepId | "done";
  steps: Record<SetupStepId, boolean>;
  passwordSet: boolean;
  // `owner/name` once stored.
  repo: string | null;
  repoPath: string;
};

export type AccessCheck = {
  ok: boolean;
  error: string | null;
  access: RepositoryAccess | null;
  missing: RepositoryPermission[];
};

export type SmokeCheck = {
  ok: boolean;
  error: string | null;
  claudeVersion: string | null;
  model: string | null;
};

// Keys in the `installation` table that remember which secrets passed their check.
export const SETUP_KEYS = {
  accessVerified: "setup.access.verified",
  smokeVerified: "setup.smoke.verified",
} as const;

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

export type SetupDeps = {
  config: ConfigStore;
  installation: InstallationStore;
  worktree: WorktreePort;
  driver: DriverPort;
  // Builds a GitHub port for a token and repository that may not be the stored ones yet.
  github: (github: GitHubConfig) => Pick<GitHubPort, "checkAccess">;
  log: Logger;
  hashPassword?: (password: string) => Promise<string>;
};

// A short digest that tells whether a stored secret is the one that passed its check.
export const fingerprint = (...values: string[]): string => createHash("sha256").update(values.join("\n")).digest("hex").slice(0, 16);

// The first-run wizard: every step writes its values right away, so a restart resumes where the
// human stopped. Checks remember the fingerprint of what they verified.
export class Setup {
  private readonly _listeners = new Set<() => void>();
  private readonly _hashPassword: (password: string) => Promise<string>;
  private _announced = false;

  constructor(private readonly _deps: SetupDeps) {
    this._hashPassword = _deps.hashPassword ?? argonHash;
  }

  // Runs once the last step is done through this object; the Orchestrator starts on it.
  onComplete(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  async status(): Promise<SetupStatus> {
    const config = this._deps.config.current();
    const steps: Record<SetupStepId, boolean> = {
      password: config.passwordHash !== undefined,
      repository: config.github !== undefined,
      access: this.accessVerified(),
      oauth: this.oauthToken() !== undefined,
      smoke: this.smokeVerified(),
      clone: await this._cloned(),
    };
    const current = SETUP_STEPS.find((step) => !steps[step]) ?? "done";
    return {
      required: current !== "done",
      current,
      steps,
      passwordSet: steps.password,
      repo: config.github ? `${config.github.owner}/${config.github.repo}` : null,
      repoPath: config.repoPath,
    };
  }

  async isComplete(): Promise<boolean> {
    return !(await this.status()).required;
  }

  accessVerified(): boolean {
    const github = this._deps.config.current().github;
    return github !== undefined && this._deps.installation.find(SETUP_KEYS.accessVerified) === accessFingerprint(github);
  }

  smokeVerified(): boolean {
    const token = this.oauthToken();
    return token !== undefined && this._deps.installation.find(SETUP_KEYS.smokeVerified) === fingerprint(token);
  }

  oauthToken(): string | undefined {
    return this._deps.config.current().values[ENV_KEYS.oauthToken] || undefined;
  }

  async setPassword(password: string): Promise<SetupStatus> {
    if (typeof password !== "string" || password.trim() === "") throw new SetupError("password must not be empty");
    const hash = await this._hashPassword(password);
    this._deps.config.update({ [ENV_KEYS.passwordHash]: hash });
    this._deps.log.info("installation password stored");
    return this._afterStep();
  }

  async setRepository(input: { repo: string; token: string }): Promise<SetupStatus> {
    const repo = typeof input.repo === "string" ? input.repo.trim() : "";
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (!REPO_PATTERN.test(repo)) throw new SetupError('repository must be "owner/name"');
    if (token === "") throw new SetupError("GitHub token must not be empty");
    try {
      this._deps.config.update({ [ENV_KEYS.githubRepo]: repo, [ENV_KEYS.githubToken]: token });
    } catch (error) {
      if (error instanceof ConfigError) throw new SetupError(error.message);
      throw error;
    }
    this._deps.log.info({ repo }, "product repository stored");
    return this._afterStep();
  }

  // Checks the stored token against the stored repository; a token can also be checked before it
  // is stored, which the Settings page does.
  async checkAccess(candidate?: GitHubConfig): Promise<AccessCheck> {
    const github = candidate ?? this._deps.config.current().github;
    if (!github) throw new SetupError("the repository and the GitHub token are not stored yet");
    let access: RepositoryAccess;
    try {
      access = await this._deps.github(github).checkAccess();
    } catch (error) {
      const message = error instanceof GitHubError ? `GitHub answered ${error.status}: ${error.message}` : error instanceof Error ? error.message : String(error);
      this._deps.log.warn({ err: error, repo: `${github.owner}/${github.repo}` }, "access check failed");
      return { ok: false, error: message, access: null, missing: [] };
    }
    const missing = missingPermissions(access);
    if (missing.length > 0) {
      this._deps.log.warn({ repo: access.fullName, missing }, "token lacks permissions");
      return { ok: false, error: `the token lacks ${missing.map(permissionLabel).join(", ")} on ${access.fullName}`, access, missing };
    }
    this._deps.installation.set(SETUP_KEYS.accessVerified, accessFingerprint(github));
    this._deps.log.info({ repo: access.fullName }, "access check passed");
    await this._afterStep();
    return { ok: true, error: null, access, missing };
  }

  async setOauthToken(token: string): Promise<SetupStatus> {
    const trimmed = typeof token === "string" ? token.trim() : "";
    if (trimmed === "") throw new SetupError("OAuth token must not be empty");
    this._deps.config.update({ [ENV_KEYS.oauthToken]: trimmed });
    this._deps.log.info("claude oauth token stored");
    return this._afterStep();
  }

  // A one-Turn query under the token proves that the CLI starts and the subscription answers.
  async smokeQuery(candidate?: string): Promise<SmokeCheck> {
    const token = candidate ?? this.oauthToken();
    if (token === undefined) throw new SetupError("the Claude OAuth token is not stored yet");
    const config = this._deps.config.current();
    const result: SmokeQueryResult = await this._deps.driver.smokeQuery({ cwd: config.dataDir, env: { CLAUDE_CODE_OAUTH_TOKEN: token } });
    if (!result.ok) {
      this._deps.log.warn({ error: result.error }, "smoke query failed");
      return { ok: false, error: result.error, claudeVersion: null, model: null };
    }
    this._deps.installation.set(SETUP_KEYS.smokeVerified, fingerprint(token));
    this._deps.log.info({ claudeVersion: result.claudeVersion, model: result.model }, "smoke query passed");
    await this._afterStep();
    return { ok: true, error: null, claudeVersion: result.claudeVersion, model: result.model };
  }

  async clone(): Promise<SetupStatus> {
    const config = this._deps.config.current();
    if (!config.github) throw new SetupError("the repository and the GitHub token are not stored yet");
    if (!(await this._cloned())) {
      const url = cloneUrlOf(config.github);
      this._deps.log.info({ url, path: config.repoPath }, "cloning the Product");
      await this._deps.worktree.clone({ url, path: config.repoPath });
    }
    return this._afterStep();
  }

  private async _cloned(): Promise<boolean> {
    return this._deps.worktree.isRepository(this._deps.config.current().repoPath);
  }

  private async _afterStep(): Promise<SetupStatus> {
    const status = await this.status();
    if (!status.required && !this._announced) {
      this._announced = true;
      this._deps.log.info("first-run setup completed");
      for (const listener of this._listeners) listener();
    }
    return status;
  }
}

const accessFingerprint = (github: GitHubConfig): string => fingerprint(github.owner, github.repo, github.token);

const PERMISSION_LABELS: Record<RepositoryPermission, string> = {
  metadataRead: "Metadata: read",
  contentsWrite: "Contents: write",
  issuesWrite: "Issues: write",
  pullRequestsWrite: "Pull requests: write",
};

export const permissionLabel = (permission: RepositoryPermission): string => PERMISSION_LABELS[permission];
