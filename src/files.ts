// File loading utilities for context injection

import { glob } from "glob";
import { readFileSync, statSync } from "fs";
import { resolve, relative } from "path";
import { config } from "./config.ts";

export interface FileContent {
  path: string;
  content: string;
}

export async function loadFiles(
  patterns: string[],
  baseDir: string = process.cwd()
): Promise<FileContent[]> {
  const resolvedBase = resolve(baseDir);
  const files: FileContent[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    // Handle negation patterns: remove previously matched files
    if (pattern.startsWith("!")) {
      const negPattern = pattern.slice(1);
      const matches = await glob(negPattern, {
        cwd: resolvedBase,
        absolute: true,
        ignore: config.defaultExcludes,
      });
      for (const match of matches) {
        seen.delete(match);
      }
      // Filter the files array to remove negated matches
      const negSet = new Set(matches);
      for (let i = files.length - 1; i >= 0; i--) {
        const absPath = resolve(resolvedBase, files[i].path);
        if (negSet.has(absPath)) {
          files.splice(i, 1);
        }
      }
      continue;
    }

    const matches = await glob(pattern, {
      cwd: resolvedBase,
      absolute: true,
      ignore: config.defaultExcludes,
    });

    for (const match of matches) {
      if (seen.has(match)) continue;

      // Path boundary check: reject files outside baseDir
      const resolved = resolve(match);
      if (!resolved.startsWith(resolvedBase + "/") && resolved !== resolvedBase) {
        continue;
      }

      try {
        const stat = statSync(match);
        if (!stat.isFile()) continue;

        // Skip binary files and very large files
        if (stat.size > 500000) continue; // 500KB limit

        const content = readFileSync(match, "utf-8");

        // Skip binary content
        if (content.includes("\0")) continue;

        seen.add(match);
        files.push({
          path: relative(resolvedBase, match),
          content,
        });

        // Enforce max file count
        if (files.length >= config.maxFileCount) {
          throw new Error(
            `File limit exceeded: matched ${files.length}+ files (max: ${config.maxFileCount}). Use more specific patterns or negation (!pattern) to narrow scope.`
          );
        }
      } catch (err) {
        // Re-throw our own limit error
        if (err instanceof Error && err.message.startsWith("File limit exceeded")) {
          throw err;
        }
        // Skip files we can't read
      }
    }
  }

  return files;
}

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

export function formatPromptWithFiles(
  prompt: string,
  files: FileContent[]
): string {
  if (files.length === 0) return prompt;

  let result = prompt + "\n\n---\n\n## File Context\n\n";

  for (const file of files) {
    const ext = file.path.split(".").pop() || "";
    result += `### ${file.path}\n\n\`\`\`${ext}\n${file.content}\n\`\`\`\n\n`;
  }

  return result;
}

export async function loadCodebaseMap(cwd: string): Promise<string | null> {
  const mapPaths = [
    resolve(cwd, "docs/CODEBASE_MAP.md"),
    resolve(cwd, "CODEBASE_MAP.md"),
    resolve(cwd, "docs/ARCHITECTURE.md"),
  ];

  for (const mapPath of mapPaths) {
    try {
      const content = readFileSync(mapPath, "utf-8");
      return content;
    } catch {
      // Try next path
    }
  }

  return null;
}
