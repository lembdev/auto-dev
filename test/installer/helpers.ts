import { readFileSync } from "node:fs";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export const readRepoFile = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

// Default of a `var_x="${var_x:-value}"` line in a ct script, the form the engine reads.
export const ctDefault = (script: string, name: string): string | undefined => {
  const match = script.match(new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"$`, "m"));
  return match?.[1];
};

export type UnitFile = Record<string, Record<string, string[]>>;

// Sections of a systemd unit; a key repeated inside a section keeps every value, as systemd does for Environment=.
export const parseUnit = (text: string): UnitFile => {
  const unit: UnitFile = {};
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = line.match(/^\[(.+)]$/);
    if (header) {
      section = header[1] as string;
      unit[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || section === "") throw new Error(`not a unit line: ${raw}`);
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const target = unit[section] as Record<string, string[]>;
    (target[key] ??= []).push(value);
  }
  return unit;
};

export const environmentOf = (unit: UnitFile): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const entry of unit.Service?.Environment ?? []) {
    for (const assignment of entry.match(/(?:"[^"]*"|\S)+/g) ?? []) {
      const unquoted = assignment.replace(/^"|"$/g, "");
      const eq = unquoted.indexOf("=");
      env[unquoted.slice(0, eq)] = unquoted.slice(eq + 1);
    }
  }
  return env;
};
