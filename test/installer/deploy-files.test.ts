import { describe, expect, it } from "vitest";
import { environmentOf, parseUnit, readRepoFile } from "./helpers.js";

describe("deploy/auto-dev.service", () => {
  const unit = parseUnit(readRepoFile("deploy/auto-dev.service"));
  const service = unit.Service ?? {};
  const env = environmentOf(unit);

  it("runs the current release as the auto-dev user, restarted always, enabled at boot", () => {
    expect(service.User).toEqual(["auto-dev"]);
    expect(service.Type).toEqual(["simple"]);
    expect(service.Restart).toEqual(["always"]);
    expect(service.ExecStart).toEqual(["/usr/bin/node /opt/auto-dev/current/dist/main.js"]);
    expect(service.WorkingDirectory).toEqual(["/opt/auto-dev/current"]);
    expect(unit.Install?.WantedBy).toEqual(["multi-user.target"]);
    expect(unit.Unit?.After?.join(" ")).toContain("network-online.target");
  });

  it("points the Installation at the env file, the data dir and the claude of the auto-dev user", () => {
    expect(env.AUTO_DEV_ENV_FILE).toBe("/etc/auto-dev/env");
    expect(env.AUTO_DEV_DATA_DIR).toBe("/var/lib/auto-dev");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/var/lib/auto-dev/claude");
    expect(env.AUTO_DEV_CLAUDE_PATH).toBe("/home/auto-dev/.local/bin/claude");
    expect(env.HOME).toBe("/home/auto-dev");
    expect(env.PATH?.split(":")).toContain("/home/auto-dev/.local/bin");
    expect(env.NODE_ENV).toBe("production");
  });

  it("leaves the secrets to the process: systemd must not load the env file into the environment", () => {
    // Process variables win over the file, so a token loaded by systemd at start would shadow one the Settings page writes later.
    expect(service.EnvironmentFile ?? []).not.toContain("/etc/auto-dev/env");
    expect(service.EnvironmentFile ?? []).not.toContain("-/etc/auto-dev/env");
  });

  it("writes its logs to journald and lets the Orchestrator stop the Agents itself", () => {
    expect(service.StandardOutput).toEqual(["journal"]);
    expect(service.StandardError).toEqual(["journal"]);
    expect(service.SyslogIdentifier).toEqual(["auto-dev"]);
    expect(service.KillMode).toEqual(["mixed"]);
  });
});

describe("deploy/auto-dev.sudoers", () => {
  const rules = readRepoFile("deploy/auto-dev.sudoers")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  it("allows auto-dev exactly the updater and its own journal, without a password", () => {
    expect(rules).toEqual([
      "auto-dev ALL=(root) NOPASSWD: /usr/bin/update",
      "auto-dev ALL=(root) NOPASSWD: /usr/bin/journalctl -u auto-dev *",
    ]);
  });
});
