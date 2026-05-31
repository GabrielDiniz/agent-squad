import type { ExecutionCheckpointState } from "../queue/backend.js";

type ToolProgressEntry = NonNullable<ExecutionCheckpointState["toolProgress"]>[number];

export interface BuildCheckpointStateInput {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  softBudgetMode: boolean;
  maxTokenRecoveries: number;
  promptMode: "compact" | "balanced" | "deep";
  summary: string;
  lastCriticalEvent?: string;
  metadata?: Record<string, unknown>;
  toolProgress?: ToolProgressEntry[];
  maxToolProgressEntries: number;
}

export function buildCheckpointState(input: BuildCheckpointStateInput): ExecutionCheckpointState {
  const maxEntries = Math.max(1, Math.floor(input.maxToolProgressEntries));
  return {
    core: {
      turns: input.turns,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheCreationTokens: input.cacheCreationTokens,
      softBudgetMode: input.softBudgetMode,
      maxTokenRecoveries: input.maxTokenRecoveries,
      promptMode: input.promptMode,
    },
    context: {
      summary: input.summary,
      lastCriticalEvent: input.lastCriticalEvent,
      metadata: input.metadata,
    },
    toolProgress: input.toolProgress ? input.toolProgress.slice(-maxEntries) : [],
  };
}
