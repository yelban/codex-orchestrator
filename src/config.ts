// Configuration for codex-agent

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

  // Default inactivity timeout in minutes for running jobs
  defaultTimeout: 60,

  // Default number of jobs to show in listings
  jobsListLimit: 20,

  // tmux session prefix
  tmuxPrefix: "codex-agent",

  // Idle detection for interactive mode
  idleDetectionEnabled: true,
  idleGracePeriodSeconds: 30,
};

export type ReasoningEffort = typeof config.reasoningEfforts[number];
export type SandboxMode = typeof config.sandboxModes[number];
