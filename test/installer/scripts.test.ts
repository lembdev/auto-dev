import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ctDefault, readRepoFile, repoRoot } from "./helpers.js";

const CORE_SHA = /^[0-9a-f]{40}$/;
const SCRIPTS = ["ct/auto-dev.sh", "install/auto-dev-install.sh", "scripts/package-release.sh", "deploy/auto-dev-update.sh", "deploy/update"];

const hasShellcheck = spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status === 0;

describe("shell scripts", () => {
  it.each(SCRIPTS)("%s parses with bash -n", (script) => {
    expect(() => execFileSync("bash", ["-n", script], { cwd: repoRoot, stdio: "pipe" })).not.toThrow();
  });

  it.skipIf(!hasShellcheck).each(SCRIPTS)("%s passes shellcheck", (script) => {
    // SC2034/SC2154: the var_* settings and the colour and status variables belong to the engine the scripts source at run time.
    const result = spawnSync("shellcheck", ["--severity=warning", "--shell=bash", "--exclude=SC2034,SC2154", script], { cwd: repoRoot, encoding: "utf8" });
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("ct/auto-dev.sh", () => {
  const script = readRepoFile("ct/auto-dev.sh");

  it("declares the guest the spec asks for: unprivileged Ubuntu 24.04 with 4 vCPU, 8 GB and 40 GB", () => {
    expect(script).toMatch(/^APP="auto-dev"$/m);
    expect(ctDefault(script, "var_cpu")).toBe("4");
    expect(ctDefault(script, "var_ram")).toBe("8192");
    expect(ctDefault(script, "var_disk")).toBe("40");
    expect(ctDefault(script, "var_os")).toBe("ubuntu");
    expect(ctDefault(script, "var_version")).toBe("24.04");
    expect(ctDefault(script, "var_unprivileged")).toBe("1");
  });

  it("defaults the container timezone to UTC so the engine never resolves it from the host", () => {
    expect(ctDefault(script, "var_timezone")).toBe("UTC");
  });

  it("boots the community-scripts engine from a pinned core and takes its own scripts from this repository", () => {
    const scriptsBase = script.match(/^_CS_DEFAULT_URL="\$\{_CS_DEFAULT_URL:-([^}]+)\}"$/m)?.[1];
    expect(scriptsBase).toBe("https://raw.githubusercontent.com/lembdev/auto-dev/main");
    const coreBase = script.match(/^_CS_CORE_DEFAULT_URL="\$\{_CS_CORE_DEFAULT_URL:-([^}]+)\}"$/m)?.[1];
    expect(coreBase?.replace("https://raw.githubusercontent.com/community-scripts/core/", "")).toMatch(CORE_SHA);
    expect(script).toContain("/core/build.func");
    // The engine's lifecycle depends on this exact order.
    const order = ["header_info \"$APP\"", "variables", "color", "catch_errors", "function update_script()", "start", "build_container", "description"];
    const positions = order.map((call) => script.indexOf(call));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("downloads a newer GitHub release of lembdev/auto-dev and hands it to the update procedure of that release", () => {
    const body = script.slice(script.indexOf("function update_script()"), script.indexOf("\nstart\n"));
    const order = [
      'check_for_gh_release "auto-dev" "lembdev/auto-dev"',
      'staging="$(mktemp -d /opt/auto-dev/.deploy.XXXXXX)"',
      'fetch_and_deploy_gh_release "auto-dev" "lembdev/auto-dev" "prebuild" "latest" "$staging" "auto-dev-*.tar.gz"',
      'bash "$staging/deploy/auto-dev-update.sh" install "$staging"',
    ];
    const positions = order.map((line) => body.indexOf(line));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The stop belongs to the procedure, after the Pause and the wait for the Turns.
    expect(body).not.toContain("systemctl stop");
    expect(body.trimEnd().endsWith("exit\n}")).toBe(true);
  });

  it("tells the person where the first-run wizard is", () => {
    expect(script).toContain("http://${IP}:8080");
  });
});

describe("install/auto-dev-install.sh", () => {
  const script = readRepoFile("install/auto-dev-install.sh");

  it("follows the engine's install lifecycle", () => {
    const order = ['source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"', "color", "verb_ip6", "catch_errors", "setting_up_container", "network_check", "update_os", "motd_ssh", "customize", "cleanup_lxc"];
    const positions = order.map((call) => script.indexOf(call));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("installs git, gh and Node 22 and the native claude as the auto-dev user", () => {
    expect(script).toMatch(/apt install -y[^\n]* git/);
    expect(script).toContain('fetch_and_deploy_gh_release "gh" "cli/cli" "binary"');
    expect(script).toContain('NODE_VERSION="22" setup_nodejs');
    expect(script).toMatch(/runuser -l "?\$?\{?APP_USER\}?"? -c 'curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash'/);
    expect(script).not.toContain("DISABLE_AUTOUPDATER");
  });

  it("creates the auto-dev user without sudo beyond the shipped rules and lays out the directories", () => {
    expect(script).toMatch(/^APP_USER="auto-dev"$/m);
    expect(script).toMatch(/useradd[^\n]*"\$APP_USER"/);
    expect(script).toMatch(/usermod -aG systemd-journal/);
    expect(script).not.toMatch(/usermod -aG sudo/);
    expect(script).toContain("/etc/sudoers.d/auto-dev");
    expect(script).toContain("visudo -cf");
    for (const dir of ["/etc/auto-dev", "/var/lib/auto-dev", "/var/lib/auto-dev/claude", "/opt/auto-dev/releases"]) {
      expect(script).toContain(dir);
    }
    // The wizard creates the env file itself; an empty one would only confuse the "file exists" status.
    expect(script).not.toContain("/etc/auto-dev/env");
  });

  it("puts the update command that knows --rollback ahead of the engine's one", () => {
    expect(script).toContain("install -m 0755 /opt/auto-dev/current/deploy/update /usr/local/bin/update");
  });

  it("deploys the latest release under releases/<version>, points current at it and enables the service", () => {
    expect(script).toMatch(/fetch_and_deploy_gh_release "auto-dev" "lembdev\/auto-dev" "prebuild" "latest" "[^"]+" "auto-dev-\*\.tar\.gz"/);
    expect(script).toContain('jq -r .version "');
    expect(script).toMatch(/ln -sfn [^\n]*current/);
    expect(script).toContain("/etc/systemd/system/auto-dev.service");
    expect(script).toMatch(/systemctl enable -q --now auto-dev/);
  });
});
