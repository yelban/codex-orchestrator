import { describe, expect, test } from "bun:test";
import { extractSessionId, parseSessionFile } from "./session-parser.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("extractSessionId", () => {
  test("matches `session id: <id>` form", () => {
    expect(extractSessionId("session id: abcdef12-3456-7890")).toBe("abcdef12-3456-7890");
  });

  test("matches `session_id=<id>` form", () => {
    expect(extractSessionId("foo session_id=deadbeef99")).toBe("deadbeef99");
  });

  test("matches camelCase `sessionId: <id>` form", () => {
    expect(extractSessionId('"sessionId": "0123abcd-ef45"')).toBe("0123abcd-ef45");
  });

  test("strips ANSI before matching", () => {
    const noisy = "[31msession id: feedface1234[0m";
    expect(extractSessionId(noisy)).toBe("feedface1234");
  });

  test("returns null when no pattern matches", () => {
    expect(extractSessionId("nothing here")).toBeNull();
  });

  test("rejects ids shorter than 8 hex chars", () => {
    expect(extractSessionId("session id: abc")).toBeNull();
  });
});

describe("parseSessionFile", () => {
  let tmp: string;
  function fixture(name: string, contents: string): string {
    if (!tmp) tmp = mkdtempSync(join(tmpdir(), "session-parser-test-"));
    const path = join(tmp, name);
    writeFileSync(path, contents);
    return path;
  }

  test("returns null for non-existent file", () => {
    expect(parseSessionFile("/definitely/not/a/real/file.jsonl")).toBeNull();
  });

  test("parses tokens from jsonl token_count event", () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100, output_tokens: 50 },
          model_context_window: 200000,
        },
      },
    });
    const result = parseSessionFile(fixture("a.jsonl", line + "\n"));
    expect(result?.tokens).toEqual({
      input: 100,
      output: 50,
      context_window: 200000,
      context_used_pct: 0.05,
    });
  });

  test("captures last assistant agent_message as summary", () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "first reply" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "final reply" },
      }),
    ].join("\n");
    const result = parseSessionFile(fixture("b.jsonl", lines));
    expect(result?.summary).toBe("final reply");
  });

  test("extracts files_modified from apply_patch tool call", () => {
    const patchInput =
      "*** Begin Patch\n" +
      "*** Update File: src/foo.ts\n" +
      "@@ -1 +1 @@\n" +
      "-old\n+new\n" +
      "*** Add File: src/bar.ts\n" +
      "+content\n" +
      "*** End Patch\n";
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: patchInput,
      },
    });
    const result = parseSessionFile(fixture("c.jsonl", line));
    expect(result?.files_modified).toContain("src/foo.ts");
    expect(result?.files_modified).toContain("src/bar.ts");
  });

  test("skips malformed jsonl lines without crashing", () => {
    const content = "not valid json\n" + JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "ok" },
    });
    const result = parseSessionFile(fixture("d.jsonl", content));
    expect(result?.summary).toBe("ok");
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });
});

import { afterAll } from "bun:test";
