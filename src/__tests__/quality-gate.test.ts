import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  enforceQualityGateTransition,
  getQualityGateThreshold,
  isQualityGateEnabled,
  updateQualityGateEvidence,
  updateQualityGateRisk,
  type QualityGateState,
} from "../agents/quality-gate.js";

const envSnapshot = { ...process.env };

afterEach(() => {
  process.env = { ...envSnapshot };
});

function initialGate(): QualityGateState {
  return {
    enabled: true,
    required: false,
    passed: false,
    maxRiskScore: 0,
    blockedTransitions: 0,
  };
}

describe("quality gate", () => {
  it("habilita por flag global + agente", () => {
    process.env.RESUME_ENABLE_QUALITY_GATES = "1";
    process.env.REVIEWER_ENABLE_QUALITY_GATES = "1";
    expect(isQualityGateEnabled("REVIEWER")).toBe(true);
  });

  it("marca gate como obrigatório quando risco passa do threshold", () => {
    process.env.IMPLEMENTOR_QUALITY_GATE_RISK_THRESHOLD = "0.2";
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          "Preciso de uma migration com transaction, rollback, lock, retry e impacto entre módulos; avaliar riscos e mitigação.",
      },
    ];

    const threshold = getQualityGateThreshold("IMPLEMENTOR");
    const gate = updateQualityGateRisk(initialGate(), messages, threshold);

    expect(gate.maxRiskScore).toBeGreaterThan(0);
    expect(gate.required).toBe(true);
  });

  it("bloqueia transição terminal sem evidência", () => {
    const gate: QualityGateState = {
      ...initialGate(),
      required: true,
    };

    const enforced = enforceQualityGateTransition(gate, "Code Review", ["Code Review"]);

    expect(enforced.blocked).toBe(true);
    expect(enforced.gate.blockedTransitions).toBe(1);
  });

  it("libera transição após evidência QUALITY_GATE_OK", () => {
    const gate: QualityGateState = {
      ...initialGate(),
      required: true,
    };

    const withEvidence = updateQualityGateEvidence(
      gate,
      "QUALITY_GATE_OK: escopo validado; impacto mapeado; risco/mitigação definidos; validação com testes planejada."
    );
    const enforced = enforceQualityGateTransition(withEvidence, "Code Review", ["Code Review"]);

    expect(withEvidence.passed).toBe(true);
    expect(enforced.blocked).toBe(false);
  });
});
