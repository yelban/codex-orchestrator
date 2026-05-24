// Auto-onboard the working directory to codex's per-project trust list.
//
// codex 0.133.0 prompts "Do you trust this directory?" on first interactive
// use of any new directory. The dialog swallows keystrokes (including the
// prompt we feed via "$(cat promptFile)") until the user picks 1/2. For an
// orchestration tool that wants zero-interaction launches, we pre-write the
// trust marker into ~/.codex/config.toml ourselves.
//
// Race policy (decided 2026-05-24): read-then-append. If the project section
// is missing we append; if any section for this path already exists we leave
// it alone so the user's explicit choice (e.g. trust_level = "untrusted") is
// preserved. The race window between two simultaneous codex-agent invocations
// is small; both writes would produce identical content anyway.

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { atomicWriteFileSync } from "./fs-utils.ts";

function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

function escapeForTomlBasicString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function projectSectionHeader(projectPath: string): string {
  return `[projects."${escapeForTomlBasicString(projectPath)}"]`;
}

export function ensureTrustedProject(projectPath: string): void {
  const configPath = codexConfigPath();
  let existing = "";
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, "utf-8");
    } catch {
      return;
    }
  }

  const header = projectSectionHeader(projectPath);
  if (existing.includes(header)) return;

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const block = `${separator}\n${header}\ntrust_level = "trusted"\n`;
  atomicWriteFileSync(configPath, existing + block);
}
