import type { AgentRunner } from "../agents/agent-runner.js";
import { ENV_KEYS, type ConfigStore, type EnvPatch } from "../config-store.js";
import type { InstallationStore } from "../index/runtime-index.js";
import type { Logger } from "../log.js";
import type { DriverPort, ModelOption } from "../ports/driver.js";
import type { InstallationState } from "../orchestrator/installation-state.js";
import { INSTALLATION_KEYS } from "../orchestrator/orchestrator.js";
import { MAX_QA_ROUNDS_KEY, type QaStage } from "../orchestrator/qa.js";
import { hashPassword as argonHash } from "../server/auth.js";
import type { Setup } from "./setup.js";

export type SettingsView = {
  maxParallelTasks: number;
  prearmEnabled: boolean;
  maxQaRounds: number;
  // Model alias the Agents launch with; null is the CLI default.
  model: string | null;
  repo: string | null;
  // Which secrets are stored; their values never leave the Installation.
  secrets: { githubToken: boolean; oauthToken: boolean; password: boolean };
};

// Body of `PUT /api/settings`: only the fields present change.
export type SettingsPatch = {
  maxParallelTasks?: number;
  prearmEnabled?: boolean;
  maxQaRounds?: number;
  // A `value` from the models list; null or "default" goes back to the CLI default.
  model?: string | null;
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
  agentModel: () => string | null;
  // Lists the models of the subscription; `cwd` is where that short CLI process runs.
  driver: Pick<DriverPort, "listModels">;
  cwd: string;
  setup: Pick<Setup, "checkAccess" | "smokeQuery">;
  log: Logger;
  hashPassword?: (password: string) => Promise<string>;
};

export const MAX_PARALLEL_TASKS_LIMIT = 16;
export const MAX_QA_ROUNDS_LIMIT = 20;
// The CLI is asked for the models again after this; the list changes with the CLI and the plan.
export const MODELS_TTL_MS = 60 * 60_000;
const DEFAULT_MODEL = "default";

export type ModelsView = { models: ModelOption[]; error: string | null };

// The Settings page: numbers live in `installation` and apply on the next cycle, secrets go to the
// env file and reach new processes at once; live Agents restart softly at the end of their Turn.
export class Settings {
  private readonly _hashPassword: (password: string) => Promise<string>;
  private _models: { list: ModelOption[]; at: number } | undefined;

  constructor(private readonly _deps: SettingsDeps) {
    this._hashPassword = _deps.hashPassword ?? argonHash;
  }

  view(): SettingsView {
    const config = this._deps.config.current();
    return {
      maxParallelTasks: this._deps.maxParallelTasks(),
      prearmEnabled: this._deps.state.prearmEnabled(),
      maxQaRounds: this._deps.qa.maxRounds(),
      model: this._deps.agentModel(),
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
    const model = await this._validateModel(patch);
    const secrets = await this._validateSecrets(patch);

    if (model !== undefined) {
      if (model === null) this._deps.installation.delete(INSTALLATION_KEYS.agentModel);
      else this._deps.installation.set(INSTALLATION_KEYS.agentModel, model);
      this._deps.log.info({ model: model ?? DEFAULT_MODEL }, "agent model changed");
    }

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

  // The models the subscription offers, cached for an hour; a failure is reported, not thrown.
  async models(now = Date.now()): Promise<ModelsView> {
    if (this._models && now - this._models.at < MODELS_TTL_MS) return { models: this._models.list, error: null };
    try {
      const list = await this._deps.driver.listModels({ cwd: this._deps.cwd });
      this._models = { list, at: now };
      return { models: list, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._deps.log.warn({ err: error }, "listing the models failed");
      return { models: this._models?.list ?? [], error: message };
    }
  }

  // undefined: no change; null: back to the CLI default.
  private async _validateModel(patch: SettingsPatch): Promise<string | null | undefined> {
    if (patch.model === undefined) return undefined;
    if (patch.model === null || patch.model === DEFAULT_MODEL) return null;
    if (typeof patch.model !== "string" || patch.model.trim() === "") throw new SettingsError("model must be a non-empty string or null");
    const model = patch.model.trim();
    const { models, error } = await this.models();
    if (error === null && !models.some((option) => option.value === model)) {
      throw new SettingsError(`model must be one of: ${models.map((option) => option.value).join(", ")}`);
    }
    return model;
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
