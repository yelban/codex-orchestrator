// Auto-injected prompt constraint blocks for Codex 5.3 agents.
// These prevent scope drift, force context reading, and keep output concise.

const DESIGN_SCOPE_BLOCK = `<design_and_scope_constraints>
- Implement EXACTLY and ONLY what is requested.
- No extra features, no refactoring of adjacent code, no UX embellishments.
- If any instruction is ambiguous, choose the simplest valid interpretation.
- Do NOT modify files or code outside the scope of the task.
</design_and_scope_constraints>`;

const CONTEXT_LOADING_BLOCK = `<context_loading>
- Read ALL files that will be modified -- in full, not just the sections mentioned in the task.
- Also read key files they import from or that depend on them.
- Absorb surrounding patterns, naming conventions, error handling style, and architecture before writing any code.
- Do not ask clarifying questions about things that are answerable by reading the codebase.
</context_loading>`;

/**
 * Inject mandatory constraint blocks into a prompt.
 * Skips blocks that are already present (prevents duplication when
 * the user or SKILL.md already included them).
 */
export function injectConstraints(prompt: string): string {
  const blocks: string[] = [];

  if (!prompt.includes("<design_and_scope_constraints>")) {
    blocks.push(DESIGN_SCOPE_BLOCK);
  }
  if (!prompt.includes("<context_loading>")) {
    blocks.push(CONTEXT_LOADING_BLOCK);
  }

  if (blocks.length === 0) return prompt;
  return prompt + "\n\n" + blocks.join("\n\n");
}
