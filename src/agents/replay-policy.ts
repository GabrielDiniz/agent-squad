import type { ExecutionCheckpointState } from "../queue/backend.js";

export type ReplayAgent = "reviewer" | "analyst" | "implementor";
type ToolProgressEntry = NonNullable<ExecutionCheckpointState["toolProgress"]>[number];

function normalizedString(input: unknown): string {
  return String(input ?? "").trim();
}

export function getReplayCacheKey(
  agent: ReplayAgent,
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  if (toolName === "jira_get_issue") {
    const issueKey = normalizedString(toolInput.issue_key);
    return issueKey ? `jira_get_issue:${issueKey}` : null;
  }

  if (agent === "reviewer") {
    return null;
  }

  if (toolName === "list_codebases") {
    return "list_codebases";
  }

  if (toolName === "list_modules") {
    const codebase = normalizedString(toolInput.codebase);
    return codebase ? `list_modules:${codebase}` : null;
  }

  if (toolName === "bash_read") {
    const codebase = normalizedString(toolInput.codebase);
    const command = normalizedString(toolInput.command);
    return codebase && command ? `bash_read:${codebase}:${command}` : null;
  }

  return null;
}

export function upsertToolProgressState(
  toolProgressState: ToolProgressEntry[],
  cacheKey: string,
  entry: ToolProgressEntry
): void {
  const existingIndex = toolProgressState.findIndex((item) => item.cacheKey === cacheKey);
  if (existingIndex >= 0) {
    toolProgressState[existingIndex] = entry;
    return;
  }
  toolProgressState.push(entry);
}
