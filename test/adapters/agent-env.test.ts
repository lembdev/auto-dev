import { describe, expect, it } from "vitest";
import { AgentEnvError, agentEnvSourceFrom, buildAgentEnv } from "../../src/adapters/agent-env.js";

const source = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/auto-dev",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
  CLAUDE_CONFIG_DIR: "/var/lib/auto-dev/claude",
  GH_TOKEN: "ghp_test",
};

describe("Agent environment", () => {
  it("contains exactly the listed variables plus the retry watchdog", () => {
    expect(buildAgentEnv(source)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/auto-dev",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      CLAUDE_CONFIG_DIR: "/var/lib/auto-dev/claude",
      GH_TOKEN: "ghp_test",
      CLAUDE_CODE_RETRY_WATCHDOG: "1",
    });
  });

  it("adds the interrupted-turn flag and launch extras only when asked", () => {
    const env = buildAgentEnv(source, { resumeInterruptedTurn: true, extra: { AUTO_DEV_STAGE: "qa" } });
    expect(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");
    expect(env.AUTO_DEV_STAGE).toBe("qa");
    expect(buildAgentEnv(source)).not.toHaveProperty("CLAUDE_CODE_RESUME_INTERRUPTED_TURN");
  });

  it("requires PATH and HOME", () => {
    expect(() => buildAgentEnv({ ...source, HOME: "" })).toThrow(AgentEnvError);
  });

  it("never leaks other variables of the Installation into the Agent", () => {
    const values = {
      ...source,
      ANTHROPIC_API_KEY: "sk-ant-api03-leak",
      AUTO_DEV_PORT: "8080",
      LOG_LEVEL: "debug",
      NODE_OPTIONS: "--inspect",
    };
    const env = buildAgentEnv(agentEnvSourceFrom(values, { claudeConfigDir: "/unused" }));
    expect(Object.keys(env).sort()).toEqual(
      ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_RETRY_WATCHDOG", "CLAUDE_CONFIG_DIR", "GH_TOKEN", "HOME", "PATH"].sort(),
    );
  });

  it("defaults the Claude config dir to the Installation's own and skips absent secrets", () => {
    const picked = agentEnvSourceFrom({ PATH: "/bin", HOME: "/h" }, { claudeConfigDir: "/var/lib/auto-dev/claude" });
    expect(picked).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/var/lib/auto-dev/claude" });
    expect(buildAgentEnv(picked)).not.toHaveProperty("GH_TOKEN");
  });
});
