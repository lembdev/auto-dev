import type { AgentRunner } from "../agents/agent-runner.js";
import { ENV_KEYS, type ConfigStore, type EnvPatch } from "../config-store.js";
import type { InstallationStore } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { InstallationState } from "../orchestrator/installation-state.js";
import { INSTALLATION_KEYS } from "../orchestrator/orchestrator.js";
import { MAX_QA_ROUNDS_KEY, type QaStage } from "../orchestrator/qa.js";
import { hashPassword as argonHash } from "../server/auth.js";
import type { Setup } from "./setup.js";

export type SettingsView = {
  maxParallelTasks: number;
  prearmEnabled: boolean;
  maxQaRounds: number;
  repo: string | null;
  // Which secrets are stored; their values never leave the Installation.
  secrets: { githubToken: boolean; oauthToken: boolean; password: boolean };
};

// Body of `PUT /api/settings`: only the fields present change.
export type SettingsPatch = {
  maxParallelTasks?: number;
  prearmEnabled?: boolean;
  maxQaRounds?: number;
  githubToken?: string;
  oauthToken?: string;
  password?: string;
};

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export type SettingsDeps = {
  config: ConfigStore;
  installation: InstallationStore;
  state: InstallationState;
  runner: AgentRunner;
  qa: Pick<QaStage, "maxRounds">;
  maxParallelTasks: () => number;
  setup: Pick<Setup, "checkAccess" | "smokeQuery">;
  log: Logger;
  hashPassword?: (password: string) => Promise<string>;
};

export const MAX_PARALLEL_TASKS_LIMIT = 16;
export const MAX_QA_ROUNDS_LIMIT = 20;

// The Settings page: numbers live in `installation` and apply on the next cycle, secrets go to the
// env file and reach new processes at once; live Agents restart softly at the end of their Turn.
export class Settings {
  private readonly _hashPassword: (password: string) => Promise<string>;

  constructor(private readonly _deps: SettingsDeps) {
    this._hashPassword = _deps.hashPassword ?? argonHash;
  }

  view(): SettingsView {
    const config = this._deps.config.current();
    return {
      maxParallelTasks: this._deps.maxParallelTasks(),
      prearmEnabled: this._deps.state.prearmEnabled(),
      maxQaRounds: this._deps.qa.maxRounds(),
      repo: config.github ? `${config.github.owner}/${config.github.repo}` : null,
      secrets: {
        githubToken: config.github !== undefined,
        oauthToken: Boolean(config.values[ENV_KEYS.oauthToken]),
        password: config.passwordHash !== undefined,
      },
    };
  }

  // Validates everything first, so a bad field leaves the Installation untouched.
  async update(patch: SettingsPatch): Promise<SettingsView> {
    const numbers = this._validateNumbers(patch);
    const secrets = await this._validateSecrets(patch);

    if (numbers.maxParallelTasks !== undefined) this._deps.installation.set(INSTALLATION_KEYS.maxParallelTasks, String(numbers.maxParallelTasks));
    if (numbers.maxQaRounds !== undefined) this._deps.installation.set(MAX_QA_ROUNDS_KEY, String(numbers.maxQaRounds));
    if (numbers.prearmEnabled !== undefined) this._deps.state.setPrearmEnabled(numbers.prearmEnabled);

    if (Object.keys(secrets.envPatch).length > 0) {
      this._deps.config.update(secrets.envPatch);
      this._deps.log.info({ changed: Object.keys(secrets.envPatch) }, "secrets changed");
      // A Pause caused by a rejected OAuth token ends with the new one; any other Pause stays.
      if (secrets.oauthChanged && this._deps.state.findPause()?.source === "token") this._deps.state.unpause();
      await this._deps.runner.restartAfterTurn("secrets changed");
    }
    return this.view();
  }

  private _validateNumbers(patch: SettingsPatch): Pick<SettingsPatch, "maxParallelTasks" | "maxQaRounds" | "prearmEnabled"> {
    const result: Pick<SettingsPatch, "maxParallelTasks" | "maxQaRounds" | "prearmEnabled"> = {};
    if (patch.maxParallelTasks !== undefined) {
      if (!Number.isInteger(patch.maxParallelTasks) || patch.maxParallelTasks < 0 || patch.maxParallelTasks > MAX_PARALLEL_TASKS_LIMIT) {
        throw new SettingsError(`maxParallelTasks must be an integer between 0 and ${MAX_PARALLEL_TASKS_LIMIT}`);
      }
      result.maxParallelTasks = patch.maxParallelTasks;
    }
    if (patch.maxQaRounds !== undefined) {
      if (!Number.isInteger(patch.maxQaRounds) || patch.maxQaRounds < 1 || patch.maxQaRounds > MAX_QA_ROUNDS_LIMIT) {
        throw new SettingsError(`maxQaRounds must be an integer between 1 and ${MAX_QA_ROUNDS_LIMIT}`);
      }
      result.maxQaRounds = patch.maxQaRounds;
    }
    if (patch.prearmEnabled !== undefined) {
      if (typeof patch.prearmEnabled !== "boolean") throw new SettingsError("prearmEnabled must be a boolean");
      result.prearmEnabled = patch.prearmEnabled;
    }
    return result;
  }

  // A new token is checked the way the wizard checks it before it replaces the stored one.
  private async _validateSecrets(patch: SettingsPatch): Promise<{ envPatch: EnvPatch; oauthChanged: boolean }> {
    const envPatch: EnvPatch = {};
    let oauthChanged = false;
    const config = this._deps.config.current();
    if (patch.githubToken !== undefined) {
      const token = typeof patch.githubToken === "string" ? patch.githubToken.trim() : "";
      if (token === "") throw new SettingsError("githubToken must not be empty");
      if (!config.github) throw new SettingsError("the repository is not stored yet; finish the first-run wizard");
      const check = await this._deps.setup.checkAccess({ ...config.github, token });
      if (!check.ok) throw new SettingsError(check.error ?? "the token failed the access check");
      envPatch[ENV_KEYS.githubToken] = token;
    }
    if (patch.oauthToken !== undefined) {
      const token = typeof patch.oauthToken === "string" ? patch.oauthToken.trim() : "";
      if (token === "") throw new SettingsError("oauthToken must not be empty");
      const check = await this._deps.setup.smokeQuery(token);
      if (!check.ok) throw new SettingsError(check.error ?? "the token failed the smoke query");
      envPatch[ENV_KEYS.oauthToken] = token;
      oauthChanged = true;
    }
    if (patch.password !== undefined) {
      if (typeof patch.password !== "string" || patch.password.trim() === "") throw new SettingsError("password must not be empty");
      envPatch[ENV_KEYS.passwordHash] = await this._hashPassword(patch.password);
    }
    return { envPatch, oauthChanged };
  }
}
