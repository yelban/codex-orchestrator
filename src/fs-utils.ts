// Shared filesystem utilities for atomic writes and permission management

import { writeFileSync, renameSync, mkdirSync } from "fs";

/**
 * Write file atomically: write to temp file, then rename.
 * Prevents torn writes from concurrent access or crashes.
 * rename() is atomic on the same filesystem (POSIX guarantee).
 */
export function atomicWriteFileSync(filePath: string, data: string, mode = 0o600): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, data, { mode });
  renameSync(tmpPath, filePath);
}

/**
 * Ensure directory exists with restrictive permissions.
 * mode 0o700 = owner-only read/write/execute.
 */
export function ensureDirSync(dirPath: string, mode = 0o700): void {
  mkdirSync(dirPath, { recursive: true, mode });
}
