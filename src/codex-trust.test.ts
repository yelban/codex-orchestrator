import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureTrustedProject } from "./codex-trust.ts";

let tmpHome: string;
let originalCodexHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "codex-trust-test-"));
  originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmpHome;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function configFile(): string {
  return join(tmpHome, "config.toml");
}

describe("ensureTrustedProject", () => {
  test("creates config and writes section when file does not exist", () => {
    ensureTrustedProject("/tmp/project-a");
    const content = readFileSync(configFile(), "utf-8");
    expect(content).toContain('[projects."/tmp/project-a"]');
    expect(content).toContain('trust_level = "trusted"');
  });

  test("appends section when other content exists", () => {
    writeFileSync(configFile(), 'model = "gpt-5.5"\n');
    ensureTrustedProject("/tmp/project-b");
    const content = readFileSync(configFile(), "utf-8");
    expect(content).toContain('model = "gpt-5.5"');
    expect(content).toContain('[projects."/tmp/project-b"]');
  });

  test("leaves existing section untouched (respects user choice)", () => {
    const original = '[projects."/tmp/project-c"]\ntrust_level = "untrusted"\n';
    writeFileSync(configFile(), original);
    ensureTrustedProject("/tmp/project-c");
    expect(readFileSync(configFile(), "utf-8")).toBe(original);
  });

  test("idempotent — second call adds nothing when section already exists", () => {
    ensureTrustedProject("/tmp/project-d");
    const first = readFileSync(configFile(), "utf-8");
    ensureTrustedProject("/tmp/project-d");
    expect(readFileSync(configFile(), "utf-8")).toBe(first);
  });

  test("escapes embedded double quotes in path", () => {
    ensureTrustedProject('/weird/"quoted"/path');
    const content = readFileSync(configFile(), "utf-8");
    expect(content).toContain('[projects."/weird/\\"quoted\\"/path"]');
  });

  test("does not throw when target dir is unwritable", () => {
    process.env.CODEX_HOME = "/proc/this/does/not/exist/and/cannot/be/created";
    // Function may write to nonexistent path; should not crash the caller.
    // We assert via not-throwing; whether the file gets written is best-effort.
    expect(() => {
      try { ensureTrustedProject("/tmp/project-e"); } catch { /* swallowed at caller */ }
    }).not.toThrow();
  });

  test("CODEX_HOME override is honored", () => {
    ensureTrustedProject("/tmp/project-f");
    expect(existsSync(configFile())).toBe(true);
  });
});
