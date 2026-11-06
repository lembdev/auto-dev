import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRepoFile, repoRoot } from "./helpers.js";

const SCRIPT = path.join(repoRoot, "deploy", "auto-dev-update.sh");

// Stand-ins for the commands the script drives; each appends what it was asked to the shared journal.
const FAKES: Record<string, string> = {
  node: `#!/usr/bin/env bash
release="$(basename "$(dirname "$(dirname "$1")")")"
dir="$(dirname "$(dirname "$1")")"
echo "node $release $2 \${3:-}" >>"$FAKE_STATE/journal"
case "$2" in
  schema-version)
    if [[ "\${3:-}" == "--db" ]]; then cat "$FAKE_STATE/db-schema"; else cat "$dir/schema"; fi ;;
  migrate)
    if [[ "$(cat "$dir/schema")" -lt "$(cat "$FAKE_STATE/db-schema")" ]]; then echo "newer than the supported" >&2; exit 3; fi
    cp "$dir/schema" "$FAKE_STATE/db-schema"
    exit "\${FAKE_MIGRATE_EXIT:-0}" ;;
  prepare-update)
    [[ "$AUTO_DEV_DATA_DIR" == "$FAKE_DATA_DIR" ]] || exit 9
    exit "\${FAKE_PREPARE_EXIT:-0}" ;;
esac
`,
  systemctl: `#!/usr/bin/env bash
case "$1" in
  is-active) [[ -f "$FAKE_STATE/active" ]]; exit $? ;;
  stop) echo "systemctl stop" >>"$FAKE_STATE/journal"; rm -f "$FAKE_STATE/active" ;;
  start) echo "systemctl start $(basename "$(readlink "$FAKE_ROOT/current")")" >>"$FAKE_STATE/journal"; touch "$FAKE_STATE/active" ;;
  daemon-reload) echo "systemctl daemon-reload" >>"$FAKE_STATE/journal" ;;
esac
`,
  visudo: `#!/usr/bin/env bash
exit "\${FAKE_VISUDO_EXIT:-0}"
`,
};

type Layout = {
  dir: string;
  root: string;
  run(args: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
  journal(): string[];
  release(version: string, schema: number): string;
  staging(version: string, schema: number): string;
  current(): string;
  previous(): string | undefined;
  dbSchema(): string;
  etc(file: string): string;
};

describe("deploy/auto-dev-update.sh", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // /opt/auto-dev with release 0.1.0 current at schema 6, the service running, data and env next to it.
  const layout = (): Layout => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auto-dev-update-"));
    dirs.push(dir);
    const root = path.join(dir, "opt", "auto-dev");
    const state = path.join(dir, "state");
    const bin = path.join(dir, "bin");
    const data = path.join(dir, "var", "lib", "auto-dev");
    for (const sub of [path.join(root, "releases"), state, bin, data, path.join(dir, "etc", "systemd"), path.join(dir, "etc", "sudoers.d"), path.join(dir, "usr", "local", "bin")]) {
      mkdirSync(sub, { recursive: true });
    }
    for (const [name, body] of Object.entries(FAKES)) {
      writeFileSync(path.join(bin, name), body);
      chmodSync(path.join(bin, name), 0o755);
    }
    writeFileSync(path.join(state, "journal"), "");
    writeFileSync(path.join(state, "db-schema"), "6");
    writeFileSync(path.join(state, "active"), "");
    writeFileSync(path.join(data, "runtime.db"), "index");
    writeFileSync(path.join(dir, "etc", "sudoers.d", "auto-dev"), "installed sudoers\n");

    const fill = (target: string, version: string, schema: number): string => {
      mkdirSync(path.join(target, "dist"), { recursive: true });
      writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "auto-dev", version }, null, 2));
      writeFileSync(path.join(target, "dist", "main.js"), "");
      writeFileSync(path.join(target, "dist", "cli.js"), "");
      writeFileSync(path.join(target, "schema"), String(schema));
      cpSync(path.join(repoRoot, "deploy"), path.join(target, "deploy"), { recursive: true });
      writeFileSync(path.join(target, "deploy", "auto-dev.service"), `# unit of ${version}\n`);
      writeFileSync(path.join(target, "deploy", "auto-dev.sudoers"), `# sudoers of ${version}\n`);
      return target;
    };
    const releaseDir = (version: string, schema: number) => fill(path.join(root, "releases", version), version, schema);
    releaseDir("0.1.0", 6);
    symlinkSync("releases/0.1.0", path.join(root, "current"));

    const link = (name: string) => (existsSync(path.join(root, name)) ? readlinkSync(path.join(root, name)) : undefined);
    return {
      dir,
      root,
      run: (args, env = {}) => {
        const result = spawnSync("bash", [SCRIPT, ...args], {
          encoding: "utf8",
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: dir,
            FAKE_STATE: state,
            FAKE_ROOT: root,
            FAKE_DATA_DIR: data,
            AUTO_DEV_ROOT: root,
            AUTO_DEV_DATA_DIR: data,
            AUTO_DEV_UNIT_FILE: path.join(dir, "etc", "systemd", "auto-dev.service"),
            AUTO_DEV_SUDOERS_FILE: path.join(dir, "etc", "sudoers.d", "auto-dev"),
            AUTO_DEV_UPDATE_WRAPPER: path.join(dir, "usr", "local", "bin", "update"),
            AUTO_DEV_VERSION_STAMP: path.join(dir, ".auto-dev"),
            ...env,
          },
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      },
      journal: () => readFileSync(path.join(state, "journal"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== ""),
      release: releaseDir,
      staging: (version, schema) => fill(mkdtempSync(path.join(root, ".deploy.")), version, schema),
      current: () => link("current") ?? "",
      previous: () => link("previous"),
      dbSchema: () => readFileSync(path.join(state, "db-schema"), "utf8").trim(),
      etc: (file) => readFileSync(path.join(dir, "etc", file), "utf8"),
    };
  };

  describe("install", () => {
    it("pauses, stops, deploys, migrates, switches current and starts, in this order", () => {
      const l = layout();
      const staging = l.staging("0.2.0", 7);
      const result = l.run(["install", staging]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      expect(l.journal()).toEqual([
        "node 0.1.0 prepare-update",
        "systemctl stop",
        "node 0.2.0 migrate",
        "systemctl daemon-reload",
        "systemctl start 0.2.0",
      ]);
      expect(l.current()).toBe("releases/0.2.0");
      expect(l.previous()).toBe("releases/0.1.0");
      expect(existsSync(staging)).toBe(false);
      expect(l.dbSchema()).toBe("7");
    });

    it("keeps the runtime index and the data dir, refreshes the unit, sudoers and the update command", () => {
      const l = layout();
      l.run(["install", l.staging("0.2.0", 7)]);
      expect(readFileSync(path.join(l.dir, "var", "lib", "auto-dev", "runtime.db"), "utf8")).toBe("index");
      expect(l.etc("systemd/auto-dev.service")).toBe("# unit of 0.2.0\n");
      expect(l.etc("sudoers.d/auto-dev")).toBe("# sudoers of 0.2.0\n");
      expect(readFileSync(path.join(l.dir, "usr", "local", "bin", "update"), "utf8")).toBe(readRepoFile("deploy/update"));
    });

    it("keeps the installed sudoers when the new one does not pass visudo", () => {
      const l = layout();
      const result = l.run(["install", l.staging("0.2.0", 7)], { FAKE_VISUDO_EXIT: "1" });
      expect(result.status).toBe(0);
      expect(l.etc("sudoers.d/auto-dev")).toBe("installed sudoers\n");
      expect(result.stdout).toContain("does not pass visudo");
    });

    it("goes on without the preparation when the service is down or does not answer", () => {
      const down = layout();
      rmSync(path.join(down.dir, "state", "active"));
      expect(down.run(["install", down.staging("0.2.0", 7)]).status).toBe(0);
      expect(down.journal()).not.toContain("node 0.1.0 prepare-update");

      const silent = layout();
      const result = silent.run(["install", silent.staging("0.2.0", 7)], { FAKE_PREPARE_EXIT: "2" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("did not answer");
      expect(silent.current()).toBe("releases/0.2.0");
    });

    it("refuses a release older than the runtime index and starts the current one again", () => {
      const l = layout();
      const result = l.run(["install", l.staging("0.0.9", 5)]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("newer than 0.0.9");
      expect(l.current()).toBe("releases/0.1.0");
      expect(l.journal().at(-1)).toBe("systemctl start 0.1.0");
      expect(l.dbSchema()).toBe("6");
    });

    it("leaves the Installation as it was when a migration fails", () => {
      const l = layout();
      const result = l.run(["install", l.staging("0.2.0", 7)], { FAKE_MIGRATE_EXIT: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("migrations of 0.2.0 failed");
      expect(l.current()).toBe("releases/0.1.0");
      expect(l.previous()).toBeUndefined();
      expect(l.journal().at(-1)).toBe("systemctl start 0.1.0");
    });

    it("installs the same version a second time without losing the release to roll back to", () => {
      const l = layout();
      l.run(["install", l.staging("0.2.0", 7)]);
      const again = l.run(["install", l.staging("0.2.0", 7)]);
      expect(again.status).toBe(0);
      expect(l.current()).toBe("releases/0.2.0");
      expect(l.previous()).toBe("releases/0.1.0");
      expect(l.dbSchema()).toBe("7");
      expect(l.journal().at(-1)).toBe("systemctl start 0.2.0");
      expect(existsSync(path.join(l.root, "releases", "0.2.0", "dist", "main.js"))).toBe(true);
    });

    it("refuses something that is not a release", () => {
      const l = layout();
      const result = l.run(["install", path.join(l.dir, "nowhere")]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a release directory");
      expect(l.journal()).toEqual([]);
    });
  });

  describe("rollback", () => {
    it("switches current back when the schema versions match", () => {
      const l = layout();
      l.run(["install", l.staging("0.1.1", 6)]);
      const before = l.journal().length;

      const result = l.run(["rollback"]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(l.journal().slice(before)).toEqual([
        "node 0.1.1 schema-version --db",
        "node 0.1.0 schema-version",
        "node 0.1.1 prepare-update",
        "systemctl stop",
        "systemctl daemon-reload",
        "systemctl start 0.1.0",
      ]);
      expect(l.current()).toBe("releases/0.1.0");
      expect(l.previous()).toBe("releases/0.1.1");
      expect(l.etc("systemd/auto-dev.service")).toBe("# unit of 0.1.0\n");
      expect(readFileSync(path.join(l.dir, ".auto-dev"), "utf8").trim()).toBe("0.1.0");
    });

    it("refuses with an explanation when the previous release expects another schema", () => {
      const l = layout();
      l.run(["install", l.staging("0.2.0", 7)]);
      const before = l.journal().length;

      const result = l.run(["rollback"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cannot roll back to 0.1.0: it expects runtime index schema 6, the index is at 7");
      expect(l.current()).toBe("releases/0.2.0");
      expect(l.journal().slice(before)).not.toContain("systemctl stop");
    });

    it("refuses when there is nothing to roll back to", () => {
      const l = layout();
      const result = l.run(["rollback"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no previous release");
      expect(l.journal()).toEqual([]);
    });
  });
});

describe("deploy/update", () => {
  const wrapper = readRepoFile("deploy/update");

  it("handles --rollback locally and passes everything else to the engine's update", () => {
    expect(wrapper).toContain('if [[ "${1:-}" == "--rollback" ]]; then');
    expect(wrapper).toContain("exec bash /opt/auto-dev/current/deploy/auto-dev-update.sh rollback");
    expect(wrapper.trimEnd().endsWith('exec /usr/bin/update "$@"')).toBe(true);
  });
});
