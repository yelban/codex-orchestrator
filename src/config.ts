// Configuration for codex-agent

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type StorageMode = "json" | "sqlite" | "dual";
export type ExecRunner = "tmux" | "spawn";
export type Provider = "openai" | "gemini";

export const config = {
  // Default model
  model: "gpt-5.3-codex",

  // Reasoning effort levels
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,
  defaultReasoningEffort: "xhigh" as const,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
  defaultSandbox: "workspace-write" as const,

  // Job storage directory
  jobsDir: `${process.env.HOME}/.codex-agent/jobs`,

  // Inactivity timeout in minutes for running jobs (by mode)
  defaultTimeout: 60,
  interactiveTimeout: 120,

  // Default number of jobs to show in listings
  jobsListLimit: 20,

  // tmux session prefix
  tmuxPrefix: "codex-agent",

  // Idle detection for interactive mode
  idleDetectionEnabled: true,
  idleGracePeriodSeconds: 30,

  // Storage (dual = write both JSON+SQLite, read SQLite first)
  storageMode: (process.env.CODEX_AGENT_STORAGE || "dual") as StorageMode,
  sqliteDbPath: `${process.env.HOME}/.codex-agent/codex-agent.db`,

  // Exec runner (spawn = detached child_process, tmux = tmux session)
  execRunner: (process.env.CODEX_AGENT_EXEC_RUNNER || "spawn") as ExecRunner,

  // Provider selection
  provider: (process.env.CODEX_AGENT_PROVIDER || "openai") as Provider,
  providers: ["openai", "gemini"] as const,
  geminiDefaultModel: process.env.CODEX_AGENT_GEMINI_MODEL || "gemini-3.1-pro-preview",
  geminiHardMaxRuntimeMinutes: Number(process.env.CODEX_AGENT_GEMINI_HARD_MAX_MINUTES || 30),

  // File loading limits
  maxFileCount: 200,
  defaultExcludes: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.codex/**", "**/.next/**", "**/__pycache__/**"],
};

