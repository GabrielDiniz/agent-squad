import type Anthropic from "@anthropic-ai/sdk";

export type PromptMode = "compact" | "balanced" | "deep";
export type PromptModeSetting = PromptMode | "auto";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function getTextFromMessages(messages: Anthropic.MessageParam[]): string {
  const chunks: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chunks.push(msg.content);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if ((block as any)?.type === "text") {
        chunks.push((block as any).text ?? "");
      } else if ((block as any)?.type === "tool_result") {
        const content = (block as any).content;
        if (typeof content === "string") chunks.push(content);
      }
    }
  }
  return chunks.join("\n");
}

function estimateComplexityScore(messages: Anthropic.MessageParam[]): number {
  const text = getTextFromMessages(messages);
  if (!text.trim()) return 0.5;

  const textLower = text.toLowerCase();
  const lengthScore = clamp01(text.length / 6000);

  const complexityHints = [
    /arquitet|architecture|design|refactor|migra|migration|breaking/i,
    /integra|integration|dependenc|cross[-\s]?module|acopl/i,
    /queue|lock|concurr|retry|idempot|race|deadlock/i,
    /schema|database|sql|index|transaction|rollback/i,
    /security|seguran|permission|auth|credential|token/i,
    /impacto|risco|trade[-\s]?off|rollback|mitiga/i,
  ];

  let keywordHits = 0;
  for (const pattern of complexityHints) {
    if (pattern.test(textLower)) keywordHits++;
  }
  const keywordScore = clamp01(keywordHits / complexityHints.length);

  const filePathMatches = text.match(/\b[\w./-]+\.(ts|tsx|js|jsx|php|py|java|go|sql|yml|yaml|json|md)\b/gi) ?? [];
  const fileCountScore = clamp01(filePathMatches.length / 20);

  const bulletItems = (text.match(/(^|\n)[\-*]\s+/g) ?? []).length;
  const bulletScore = clamp01(bulletItems / 18);

  return clamp01(lengthScore * 0.35 + keywordScore * 0.35 + fileCountScore * 0.2 + bulletScore * 0.1);
}

export interface PromptAutoPolicyConfig {
  cooldownTurns: number;
  minTurnsForDeep: number;
  deepComplexityThreshold: number;
  deepBudgetCeiling: number;
  compactBudgetThreshold: number;
  maxSwitches: number;
}

export interface PromptDecisionInput {
  turns: number;
  totalBudgetTokens: number;
  maxTotalTokens: number;
  softBudgetMode: boolean;
  messages: Anthropic.MessageParam[];
}

export interface PromptDecision {
  mode: PromptMode;
  switched: boolean;
  reason: string;
  switchInstruction: string | null;
}

export function resolvePromptModeSetting(raw: string | undefined, compactFlag: boolean): PromptModeSetting {
  if (compactFlag) return "compact";
  const mode = (raw ?? "balanced").toLowerCase();
  if (mode === "compact" || mode === "balanced" || mode === "deep" || mode === "auto") {
    return mode;
  }
  return "balanced";
}

export function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return TRUE_VALUES.has(raw.toLowerCase());
}

export function getPromptAutoPolicyConfig(prefix: string): PromptAutoPolicyConfig {
  return {
    cooldownTurns: Math.max(0, Math.floor(envNumber(`${prefix}_PROMPT_AUTO_COOLDOWN_TURNS`, 2))),
    minTurnsForDeep: Math.max(1, Math.floor(envNumber(`${prefix}_PROMPT_AUTO_MIN_TURNS_FOR_DEEP`, 2))),
    deepComplexityThreshold: clamp01(envNumber(`${prefix}_PROMPT_AUTO_DEEP_COMPLEXITY_THRESHOLD`, 0.62)),
    deepBudgetCeiling: clamp01(envNumber(`${prefix}_PROMPT_AUTO_DEEP_BUDGET_CEILING`, 0.72)),
    compactBudgetThreshold: clamp01(envNumber(`${prefix}_PROMPT_AUTO_COMPACT_BUDGET_THRESHOLD`, 0.88)),
    maxSwitches: Math.max(1, Math.floor(envNumber(`${prefix}_PROMPT_AUTO_MAX_SWITCHES`, 4))),
  };
}

function buildSwitchInstruction(mode: PromptMode): string {
  if (mode === "compact") {
    return "PROMPT MODE: compact. Priorize tool_use para ações pendentes, respostas mínimas e sem repetição de contexto.";
  }
  if (mode === "deep") {
    return "PROMPT MODE: deep. Aplique maior rigor técnico em escopo/impacto/risco, mantendo respostas estruturadas e objetivas.";
  }
  return "PROMPT MODE: balanced. Mantenha equilíbrio entre concisão e cobertura técnica, sem verbosidade desnecessária.";
}

export class PromptModeController {
  private currentMode: PromptMode;
  private lastSwitchTurn: number;
  private switches: number;

  constructor(
    private readonly modeSetting: PromptModeSetting,
    private readonly policy: PromptAutoPolicyConfig
  ) {
    this.currentMode = modeSetting === "auto" ? "balanced" : modeSetting;
    this.lastSwitchTurn = 0;
    this.switches = 0;
  }

  getMode(): PromptMode {
    return this.currentMode;
  }

  getSwitches(): number {
    return this.switches;
  }

  decide(input: PromptDecisionInput): PromptDecision {
    if (this.modeSetting !== "auto") {
      return {
        mode: this.currentMode,
        switched: false,
        reason: "fixed",
        switchInstruction: null,
      };
    }

    const budgetPressure = input.maxTotalTokens > 0
      ? clamp01(input.totalBudgetTokens / input.maxTotalTokens)
      : 0;
    const complexity = estimateComplexityScore(input.messages);

    let target: PromptMode = "balanced";
    let reason = `complexity=${complexity.toFixed(2)} budget=${budgetPressure.toFixed(2)}`;

    if (input.softBudgetMode || budgetPressure >= this.policy.compactBudgetThreshold) {
      target = "compact";
      reason = `${reason} budget_pressure`;
    } else if (
      input.turns >= this.policy.minTurnsForDeep &&
      budgetPressure <= this.policy.deepBudgetCeiling &&
      complexity >= this.policy.deepComplexityThreshold
    ) {
      target = "deep";
      reason = `${reason} complexity_high`;
    }

    const isEmergencyBudget = input.softBudgetMode || budgetPressure >= this.policy.compactBudgetThreshold;
    const inCooldown = input.turns - this.lastSwitchTurn < this.policy.cooldownTurns;
    const canSwitchMore = this.switches < this.policy.maxSwitches;

    if (target !== this.currentMode) {
      if (!isEmergencyBudget && (inCooldown || !canSwitchMore)) {
        return {
          mode: this.currentMode,
          switched: false,
          reason: `${reason} hold=${inCooldown ? "cooldown" : "max_switches"}`,
          switchInstruction: null,
        };
      }

      this.currentMode = target;
      this.lastSwitchTurn = input.turns;
      this.switches++;
      return {
        mode: this.currentMode,
        switched: true,
        reason,
        switchInstruction: buildSwitchInstruction(this.currentMode),
      };
    }

    return {
      mode: this.currentMode,
      switched: false,
      reason,
      switchInstruction: null,
    };
  }
}