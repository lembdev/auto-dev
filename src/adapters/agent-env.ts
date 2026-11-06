// Environment of an Agent process. The SDK replaces the environment wholesale, so the
// Orchestrator hands the CLI exactly these variables and nothing from its own process.
export const AGENT_ENV_KEYS = ["PATH", "HOME", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "GH_TOKEN"] as const;

export type AgentEnvKey = (typeof AGENT_ENV_KEYS)[number];

// Values the Installation knows; `PATH` and `HOME` are required, the rest copied when present.
export type AgentEnvSource = Partial<Record<AgentEnvKey, string>> & { PATH: string; HOME: string };

export type BuildAgentEnvOptions = {
  // Makes the CLI continue a Turn that was cut by SIGTERM instead of waiting for a prompt.
  resumeInterruptedTurn?: boolean;
  // Launch-specific additions on top of the fixed list.
  extra?: Record<string, string>;
};

export class AgentEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEnvError";
  }
}

export function buildAgentEnv(source: AgentEnvSource, options: BuildAgentEnvOptions = {}): Record<string, string> {
  for (const key of ["PATH", "HOME"] as const) {
    if (!source[key]) throw new AgentEnvError(`${key} is required to launch an Agent`);
  }
  const env: Record<string, string> = {};
  for (const key of AGENT_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  // Keeps the CLI's own retry watchdog on: a hung API call gets retried instead of waiting forever.
  env.CLAUDE_CODE_RETRY_WATCHDOG = "1";
  if (options.resumeInterruptedTurn) env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = "1";
  Object.assign(env, options.extra ?? {});
  return env;
}

// Picks the Agent variables out of a merged Installation environment (env file plus process env).
export function agentEnvSourceFrom(values: Readonly<Record<string, string | undefined>>, defaults: { claudeConfigDir: string }): AgentEnvSource {
  const source: AgentEnvSource = {
    PATH: values.PATH ?? "",
    HOME: values.HOME ?? "",
    CLAUDE_CONFIG_DIR: values.CLAUDE_CONFIG_DIR ?? defaults.claudeConfigDir,
  };
  if (values.CLAUDE_CODE_OAUTH_TOKEN) source.CLAUDE_CODE_OAUTH_TOKEN = values.CLAUDE_CODE_OAUTH_TOKEN;
  // The Installation stores its token as GITHUB_TOKEN; `gh` inside an Agent reads GH_TOKEN.
  const githubToken = values.GH_TOKEN || values.GITHUB_TOKEN;
  if (githubToken) source.GH_TOKEN = githubToken;
  return source;
}
