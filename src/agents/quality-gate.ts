import type Anthropic from "@anthropic-ai/sdk";
import { envFlag, estimateComplexityScore } from "./prompt-policy.js";

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

export interface QualityGateState {
  enabled: boolean;
  required: boolean;
  passed: boolean;
  maxRiskScore: number;
  blockedTransitions: number;
  evidenceSnippet?: string;
}

export function isQualityGateEnabled(agentPrefix: string): boolean {
  return envFlag("RESUME_ENABLE_QUALITY_GATES", false) && envFlag(`${agentPrefix}_ENABLE_QUALITY_GATES`, false);
}

export function getQualityGateThreshold(agentPrefix: string): number {
  return clamp01(envNumber(`${agentPrefix}_QUALITY_GATE_RISK_THRESHOLD`, 0.72));
}

export function getQualityGateInstruction(agentName: string): string {
  return (
    `QUALITY GATE obrigatório para ${agentName} em risco alto. ` +
    `Antes de transição final, publique uma resposta textual contendo 'QUALITY_GATE_OK:' ` +
    `com checklist objetivo de escopo, impacto, risco/mitigação e validação.`
  );
}

export function updateQualityGateRisk(
  gate: QualityGateState,
  messages: Anthropic.MessageParam[],
  threshold: number
): QualityGateState {
  if (!gate.enabled) return gate;
  const score = estimateComplexityScore(messages);
  const maxRiskScore = Math.max(gate.maxRiskScore, score);
  return {
    ...gate,
    maxRiskScore,
    required: maxRiskScore >= threshold,
  };
}

export function updateQualityGateEvidence(gate: QualityGateState, text: string): QualityGateState {
  if (!gate.enabled || !gate.required || gate.passed) return gate;
  const normalized = text.toUpperCase();
  const hasToken = normalized.includes("QUALITY_GATE_OK:");
  const hasChecklist = /escopo|impacto|risco|mitiga|valida|teste/i.test(text);
  if (!hasToken || !hasChecklist) return gate;

  const snippet = text.slice(0, 300);
  return {
    ...gate,
    passed: true,
    evidenceSnippet: snippet,
  };
}

export function enforceQualityGateTransition(
  gate: QualityGateState,
  requestedStatus: string,
  terminalStatuses: string[]
): { gate: QualityGateState; blocked: boolean; message?: string } {
  if (!gate.enabled || !gate.required) {
    return { gate, blocked: false };
  }

  const isTerminal = terminalStatuses.some((status) => status.toLowerCase() === requestedStatus.toLowerCase());
  if (!isTerminal || gate.passed) {
    return { gate, blocked: false };
  }

  return {
    gate: {
      ...gate,
      blockedTransitions: gate.blockedTransitions + 1,
    },
    blocked: true,
    message:
      "Erro: QUALITY_GATE_REQUIRED. Forneça primeiro uma resposta com 'QUALITY_GATE_OK:' " +
      "incluindo escopo, impacto, risco/mitigação e validação/testes antes de concluir a transição final.",
  };
}
