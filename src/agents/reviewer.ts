import Anthropic from "@anthropic-ai/sdk";
import { dbInsertSession, dbUpdateSession, dbFinishSession, type TokenUsage } from "../db.js";
import { jiraGetIssue, jiraAddComment, jiraTransitionToStatus } from "../jira.js";
import { withRateLimit, interTurnDelay } from "../retry.js";
import { calculateCostUsd } from "../cost.js";
import {
  envFlag,
  getPromptAutoPolicyConfig,
  PromptModeController,
  resolvePromptModeSetting,
  type PromptMode,
} from "./prompt-policy.js";
import {
  enforceQualityGateTransition,
  getQualityGateInstruction,
  getQualityGateThreshold,
  isQualityGateEnabled,
  updateQualityGateEvidence,
  updateQualityGateRisk,
  type QualityGateState,
} from "./quality-gate.js";
import { buildCheckpointState } from "./checkpoint-state.js";
import { getReplayCacheKey, upsertToolProgressState } from "./replay-policy.js";
import type { ExecutionCheckpointState } from "../queue/backend.js";

const client = new Anthropic();

const APPROVED_STATUS = process.env.JIRA_APPROVED_STATUS ?? "Aprovado";
const REJECTED_STATUS = process.env.JIRA_REJECTED_STATUS ?? "Rascunho";

// Modelo específico do agente → global → default (haiku: tarefa textual simples)
const MODEL =
  process.env.CLAUDE_MODEL_REVIEWER ??
  process.env.CLAUDE_MODEL ??
  "claude-haiku-4-5-20251001";

const MAX_TURNS = Number(process.env.REVIEWER_MAX_TURNS ?? 10);
const MAX_TOKENS_PER_TURN = Number(process.env.REVIEWER_MAX_TOKENS_PER_TURN ?? 1536);
const MAX_TOKEN_RECOVERIES = Number(process.env.REVIEWER_MAX_TOKEN_RECOVERIES ?? 3);
const MAX_TOTAL_TOKENS = Number(process.env.REVIEWER_MAX_TOTAL_TOKENS ?? 12000);
const SOFT_BUDGET_RATIO = Number(process.env.REVIEWER_SOFT_BUDGET_RATIO ?? 0.8);
const SOFT_MAX_TOKENS_PER_TURN = Number(
  process.env.REVIEWER_SOFT_MAX_TOKENS_PER_TURN ?? Math.max(256, Math.floor(MAX_TOKENS_PER_TURN * 0.6))
);
const SNAPSHOT_INTERVAL = Number(process.env.REVIEWER_SNAPSHOT_INTERVAL ?? 6);
const MAX_HISTORY_MESSAGES = Number(process.env.REVIEWER_MAX_HISTORY_MESSAGES ?? 24);

const ENABLE_PROMPT_COMPACT = envFlag("REVIEWER_ENABLE_PROMPT_COMPACT", false);
const ENABLE_SNAPSHOT = envFlag("REVIEWER_ENABLE_SNAPSHOT", true);
const ENABLE_CACHE = envFlag("REVIEWER_ENABLE_CACHE", true);
const ENABLE_BUDGET = envFlag("REVIEWER_ENABLE_BUDGET", true);
const ENABLE_REPLAY_SKIP =
  envFlag("RESUME_ENABLE_REPLAY_SKIP", false) && envFlag("REVIEWER_ENABLE_REPLAY_SKIP", false);
const REPLAY_MAX_CACHED_RESULT_CHARS = Number(process.env.REVIEWER_REPLAY_MAX_CACHED_RESULT_CHARS ?? 12000);
const ENABLE_QUALITY_GATES = isQualityGateEnabled("REVIEWER");
const QUALITY_GATE_RISK_THRESHOLD = getQualityGateThreshold("REVIEWER");

const PROMPT_MODE_SETTING = resolvePromptModeSetting(process.env.REVIEWER_PROMPT_MODE, ENABLE_PROMPT_COMPACT);
const PROMPT_AUTO_POLICY = getPromptAutoPolicyConfig("REVIEWER");

// 3 tools com schema mínimo — ~300 tokens de overhead (vs ~9k do mcp-atlassian)
const TOOLS: Anthropic.Tool[] = [
  {
    name: "jira_get_issue",
    description: "Busca detalhes de um issue do Jira (título, descrição, critérios de aceite, status).",
    input_schema: {
      type: "object" as const,
      properties: { issue_key: { type: "string" } },
      required: ["issue_key"],
    },
  },
  {
    name: "jira_add_comment",
    description: "Adiciona um comentário a um issue do Jira.",
    input_schema: {
      type: "object" as const,
      properties: {
        issue_key: { type: "string" },
        comment: { type: "string" },
      },
      required: ["issue_key", "comment"],
    },
  },
  {
    name: "jira_transition_issue",
    description: "Muda o status de um issue do Jira para um novo status.",
    input_schema: {
      type: "object" as const,
      properties: {
        issue_key: { type: "string" },
        status_name: { type: "string" },
      },
      required: ["issue_key", "status_name"],
    },
    // Ponto 1 de cache: definições de tools são estáticas — cache na última tool
    ...(ENABLE_CACHE ? { cache_control: { type: "ephemeral" } as any } : {}),
  },
];

export interface AgentRunOptions {
  checkpoint?: () => Promise<void>;
  saveExecutionCheckpoint?: (checkpointSeq: number, state: ExecutionCheckpointState) => Promise<void>;
  resumeCheckpointState?: ExecutionCheckpointState | null;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  issueCache: Map<string, string>,
  onTransitionGuard?: (statusName: string) => string | null
): Promise<string> {
  try {
    if (name === "jira_get_issue") {
      const issueKey = input.issue_key as string;
      if (ENABLE_CACHE && issueCache.has(issueKey)) {
        return "Cache hit jira_get_issue: use os detalhes já retornados anteriormente nesta execução.";
      }
      const payload = await jiraGetIssue(issueKey);
      if (ENABLE_CACHE) issueCache.set(issueKey, payload);
      return payload;
    }
    if (name === "jira_add_comment") {
      await jiraAddComment(input.issue_key as string, input.comment as string);
      return "Comentário adicionado.";
    }
    if (name === "jira_transition_issue") {
      const requestedStatus = input.status_name as string;
      const blockedReason = onTransitionGuard?.(requestedStatus);
      if (blockedReason) return blockedReason;
      return await jiraTransitionToStatus(input.issue_key as string, input.status_name as string);
    }
    return `Tool desconhecida: ${name}`;
  } catch (err) {
    return `Erro: ${String(err)}`;
  }
}

function buildPrompt(issueKey: string, mode: PromptMode): string {
  if (mode === "compact") {
    return `Você é um revisor de histórias de usuário (POP-REQ-001).
Avalie a demanda ${issueKey} com postura colaborativa e objetiva.

Passos:
1. Buscar issue no Jira.
2. Avaliar com nota 0–10 os critérios e pesos:
   - formato da história (20%)
   - clareza do título (15%)
   - critérios de aceitação (30%)
   - escopo/INVEST (15%)
   - valor de negócio (15%)
   - informações de apoio (5%)
3. Calcular média ponderada.
   - média >= 6: APROVADO -> comentar notas/sugestões relevantes e transitar para "${APPROVED_STATUS}".
   - média < 6: REPROVADO -> comentar lacunas prioritárias, exemplo de correção e transitar para "${REJECTED_STATUS}".

Quando precisar de ação, responda com tool_use diretamente (sem explicação longa).
Use Markdown no comentário e não repita contexto desnecessário.`;
  }

  if (mode === "deep") {
    return `Você é um revisor de histórias de usuário (POP-REQ-001) para demandas potencialmente complexas.
Demanda alvo: ${issueKey}.

Objetivo:
- maximizar precisão da avaliação sem desperdiçar tokens.

Fluxo obrigatório:
1. Buscar issue no Jira.
2. Construir diagnóstico por critério (0-10) com evidências curtas do texto do issue:
   - formato da história (20%)
   - clareza do título (15%)
   - critérios de aceitação (30%)
   - escopo/INVEST (15%)
   - valor de negócio (15%)
   - informações de apoio (5%)
3. Se houver ambiguidade relevante, explicitar suposição mínima antes da nota.
4. Calcular média ponderada final.
5. Decisão:
   - média >= 6 -> APROVADO; comentar de forma curta e transitar para "${APPROVED_STATUS}".
   - média < 6 -> REPROVADO; comentar gaps prioritários por peso, exemplo de correção do ponto crítico e transitar para "${REJECTED_STATUS}".

Regras de eficiência:
- priorize tool_use sempre que houver ação pendente;
- evite repetir contexto já processado;
- texto livre somente para decisão final e de forma concisa.

Formato do comentário:
- Markdown com seções curtas;
- inclua: nota final, notas por critério, próximos ajustes objetivos.`;
  }

  return `Você é um revisor de histórias de usuário que segue o POP-REQ-001 da empresa.
Sua postura é CONSTRUTIVA e MODERADA — dê o benefício da dúvida quando o item estiver parcialmente atendido.
Intenção clara vale mais do que ausência de formalismo.

## Passos obrigatórios

1. **Buscar** os detalhes completos da demanda ${issueKey} no Jira.

2. **Avaliar** cada critério abaixo com nota 0–10, usando a tabela de referência de leniência:

| Critério | Peso | O que avaliar |
|---|---|---|
| **Formato da história** | 20% | Presença do padrão "Como… Eu quero… Para que…". Aceitar variações próximas (ex: "Enquanto", "Preciso"). |
| **Clareza do título** | 15% | Título resumido e com palavras-chave. Não precisa ser perfeito, apenas descritivo o suficiente. |
| **Critérios de Aceitação** | 30% | Preferência por Gherkin (Dado/Quando/Então), mas aceitar listas claras e testáveis. Ausência total = 0. |
| **Escopo e INVEST** | 15% | História cabe em um sprint, não é épico disfarçado. Ser generoso se a intenção é clara. |
| **Valor de negócio** | 15% | O "Para que" explica o benefício ao usuário/negócio. Aceitar mesmo que breve. |
| **Informações de apoio** | 5% | descrição de informações extras uteis para o desenvolvimento. Não obrigatorio caso não haja informações adicionais necessarias. |

### Tabela de leniência (nível 6/10 — moderadamente branda)
- **Atende bem** → 8–10
- **Atende parcialmente / com lacunas toleráveis** → 6–7
- **Atende minimamente, mas dá para entender** → 4–5
- **Quase ausente ou muito vago** → 2–3
- **Completamente ausente** → 0–1

> Não penalize por falta de mockup se o fluxo for simples.
> Não penalize por estimativa ausente se for um rascunho inicial claro.
> Aceite critérios de aceitação em formato de lista quando o contexto dispensar Gherkin.

3. **Calcular** a média ponderada dos critérios.
   Média ≥ 6 → **APROVADO**. Abaixo de 6 → **REPROVADO**.

4a. Se **APROVADO**:
   - Adicione um comentário bem resumido apenas com: nota geral, nota por critério, eventuais sugestões de melhoria com relevancia alta.
   - Transite o status para "${APPROVED_STATUS}".

4b. Se **REPROVADO**:
   - Adicione um comentário com:
     * Nota por critério com justificativa (seja específico, cite trechos)
     * O que precisa ser corrigido para aprovação (priorize os itens de maior peso)
     * Exemplo concreto de como reescrever o ponto mais crítico
   - Transite o status para "${REJECTED_STATUS}".

Tom do comentário: colaborativo, não punitivo. O objetivo é ajudar o analista a melhorar a história.

Regras de eficiência:
- quando precisar de ação, priorize apenas tool_use;
- evite repetir conteúdo já processado;
- mantenha respostas textuais objetivas.

Formate o comentário em **Markdown** (será convertido automaticamente para Jira):
use ## para seções, **negrito** para destaques, - para listas e \`código\` quando necessário.`;
}

/**
 * Ponto 3 de cache: rolling cache — antes de cada chamada à API, marca o último
 * bloco do último user message com cache_control: ephemeral.
 * Isso cria um checkpoint na conversa que avança turno a turno, economizando
 * os tokens do histórico já processado.
 */
function applyRollingCache(messages: Anthropic.MessageParam[]): void {
  // Limpa marcadores de turnos anteriores (índice 0 = prompt inicial — preservar)
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) delete (block as any).cache_control;
  }

  // Marca o último bloco do último user message como novo checkpoint de cache
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") break;
    if (!Array.isArray(msg.content) || msg.content.length === 0) break;
    (msg.content[msg.content.length - 1] as any).cache_control = { type: "ephemeral" };
    break;
  }
}

function isToolResultMessage(msg: Anthropic.MessageParam | undefined): boolean {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) return false;
  return msg.content.some((block: any) => block?.type === "tool_result");
}

function compactHistory(
  messages: Anthropic.MessageParam[],
  snapshotText: string
): void {
  if (messages.length <= MAX_HISTORY_MESSAGES) return;

  const tailStart = Math.max(1, messages.length - (MAX_HISTORY_MESSAGES - 2));
  const tail = messages.slice(tailStart);

  // Remove possível tool_result órfão no início do recorte
  while (tail.length > 0 && isToolResultMessage(tail[0])) {
    tail.shift();
  }

  const snapshot: Anthropic.MessageParam = {
    role: "user",
    content: [{ type: "text", text: snapshotText }],
  };

  messages.splice(1, messages.length - 1, snapshot, ...tail);
}

function getTotalBudgetTokens(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  return inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
}

async function doReview(issueKey: string, rowId: number | null, options?: AgentRunOptions): Promise<void> {
  const promptController = new PromptModeController(PROMPT_MODE_SETTING, PROMPT_AUTO_POLICY);
  let qualityGate: QualityGateState = {
    enabled: ENABLE_QUALITY_GATES,
    required: false,
    passed: false,
    maxRiskScore: 0,
    blockedTransitions: 0,
  };
  let qualityGateInstructionSent = false;
  const resumeState = options?.resumeCheckpointState ?? null;
  const resumeEnabled = (process.env.REVIEWER_ENABLE_RESUME ?? process.env.RESUME_ENABLE_FUNCTIONAL ?? "0") !== "0";
  const shouldResume = resumeEnabled && !!resumeState;

  const saveCheckpoint = async (summary: string, lastCriticalEvent?: string): Promise<void> => {
    if (!options?.saveExecutionCheckpoint) return;
    const checkpointSeq = Math.max(1, turns);
    const state: ExecutionCheckpointState = buildCheckpointState({
      turns,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      softBudgetMode,
      maxTokenRecoveries,
      promptMode: promptController.getMode(),
      summary,
      lastCriticalEvent,
      metadata: {
        qualityGateRequired: qualityGate.required,
        qualityGatePassed: qualityGate.passed,
        qualityGateMaxRiskScore: Number(qualityGate.maxRiskScore.toFixed(3)),
        qualityGateBlockedTransitions: qualityGate.blockedTransitions,
      },
      toolProgress: toolProgressState,
      maxToolProgressEntries: 25,
    });
    await options.saveExecutionCheckpoint(checkpointSeq, state);
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      // Ponto 2 de cache: prompt inicial é fixo por issue — cache para reutilizar
      // em retries e qualquer re-execução da mesma issue.
      content: [
        {
          type: "text",
          text: buildPrompt(issueKey, promptController.getMode()),
          ...(ENABLE_CACHE ? { cache_control: { type: "ephemeral" } as any } : {}),
        },
      ],
    },
  ];

  if (shouldResume && resumeState) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            `RESUME CONTEXT reviewer:\n` +
            `- summary: ${resumeState.context.summary}\n` +
            `- lastCriticalEvent: ${resumeState.context.lastCriticalEvent ?? "none"}\n` +
            `- turns_done: ${resumeState.core.turns}\n` +
            `Retome do ponto atual sem repetir etapas já concluídas. Priorize tool_use quando houver ação pendente.`,
        },
      ],
    });
  }

  let inputTokens = shouldResume && resumeState ? resumeState.core.inputTokens : 0;
  let outputTokens = shouldResume && resumeState ? resumeState.core.outputTokens : 0;
  let cacheReadTokens = shouldResume && resumeState ? resumeState.core.cacheReadTokens : 0;
  let cacheCreationTokens = shouldResume && resumeState ? resumeState.core.cacheCreationTokens : 0;
  let turns = shouldResume && resumeState ? resumeState.core.turns : 0;
  let finalStatus = "error";
  let lastHeaders: { get(name: string): string | null } | null = null;
  let maxTokenRecoveries = shouldResume && resumeState ? resumeState.core.maxTokenRecoveries : 0;
  let softBudgetMode = shouldResume && resumeState ? resumeState.core.softBudgetMode : false;
  const issueCache = new Map<string, string>();
  const toolProgressState = [...(resumeState?.toolProgress ?? [])];

  if (shouldResume && resumeState) {
    console.log(
      `[reviewer] retomada ativa issue=${issueKey} turn=${resumeState.core.turns} mode=${resumeState.core.promptMode}`
    );
  }

  try {
    while (turns < MAX_TURNS) {
      if (options?.checkpoint) {
        await options.checkpoint();
      }
      if (turns > 0 && lastHeaders) {
        await interTurnDelay("reviewer", lastHeaders);
      }
      turns++;

      if (ENABLE_SNAPSHOT && turns > 1 && turns % SNAPSHOT_INTERVAL === 0) {
        compactHistory(
          messages,
          `SNAPSHOT reviewer: turn=${turns}; tokens_in=${inputTokens}; tokens_out=${outputTokens}; ` +
            `continue do estado atual sem repetir conteúdo já processado.`
        );
      }

      if (ENABLE_CACHE) {
        applyRollingCache(messages); // Ponto 3: marca último user-block para cache
      }

      const tokensBeforeCall = getTotalBudgetTokens(
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens
      );

      const modeDecision = promptController.decide({
        turns,
        totalBudgetTokens: tokensBeforeCall,
        maxTotalTokens: MAX_TOTAL_TOKENS,
        softBudgetMode,
        messages,
      });
      qualityGate = updateQualityGateRisk(qualityGate, messages, QUALITY_GATE_RISK_THRESHOLD);
      if (modeDecision.switched && modeDecision.switchInstruction) {
        console.log(`\n[reviewer] prompt mode -> ${modeDecision.mode} (${modeDecision.reason})`);
        messages.push({
          role: "user",
          content: [{ type: "text", text: modeDecision.switchInstruction }],
        });
      }
      if (qualityGate.enabled && qualityGate.required && !qualityGateInstructionSent) {
        qualityGateInstructionSent = true;
        messages.push({
          role: "user",
          content: [{ type: "text", text: getQualityGateInstruction("reviewer") }],
        });
      }

      if (ENABLE_BUDGET && MAX_TOTAL_TOKENS > 0 && tokensBeforeCall >= MAX_TOTAL_TOKENS) {
        await saveCheckpoint("Interrompido antes da chamada por hard budget.", "hard_budget_before_call");
        console.log(`\n[reviewer] orçamento hard de tokens atingido antes da chamada (${tokensBeforeCall}/${MAX_TOTAL_TOKENS}).`);
        break;
      }

      const currentMaxTokensPerTurn = ENABLE_BUDGET && softBudgetMode
        ? Math.min(MAX_TOKENS_PER_TURN, SOFT_MAX_TOKENS_PER_TURN)
        : MAX_TOKENS_PER_TURN;

      const responseStream = client.messages.stream({
        model: MODEL,
        max_tokens: currentMaxTokensPerTurn,
        tools: TOOLS,
        messages,
      });
      const { data: messageStream, response: httpResponse } = await responseStream.withResponse();
      const response = await messageStream.finalMessage();

      lastHeaders = httpResponse.headers;

      const u = response.usage as any;
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      cacheReadTokens += u.cache_read_input_tokens ?? 0;
      cacheCreationTokens += u.cache_creation_input_tokens ?? 0;

      // Persiste acumulados após cada turno — garante dados mesmo em caso de interrupção
      if (rowId !== null) {
        const usage: TokenUsage = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
        void dbUpdateSession(rowId, turns, calculateCostUsd(MODEL, usage), usage);
      }

      const totalBudgetTokens = getTotalBudgetTokens(
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens
      );
      const softLimitTokens = Math.floor(MAX_TOTAL_TOKENS * SOFT_BUDGET_RATIO);

      if (ENABLE_BUDGET && MAX_TOTAL_TOKENS > 0 && !softBudgetMode && totalBudgetTokens >= softLimitTokens) {
        softBudgetMode = true;
        console.log(
          `\n[reviewer] orçamento soft ativado (${totalBudgetTokens}/${MAX_TOTAL_TOKENS}) — modo econômico.`
        );
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text:
                "MODO ECONÔMICO ATIVO: seja ultraobjetivo e priorize apenas tool_use quando houver ação pendente. " +
                "Evite explicações longas e não repita conteúdo já processado.",
            },
          ],
        });
      }

      if (ENABLE_BUDGET && MAX_TOTAL_TOKENS > 0 && totalBudgetTokens >= MAX_TOTAL_TOKENS && response.stop_reason !== "end_turn") {
        await saveCheckpoint("Interrompido após chamada por hard budget.", "hard_budget_after_call");
        console.log(
          `\n[reviewer] orçamento hard de tokens atingido (${totalBudgetTokens}/${MAX_TOTAL_TOKENS}) — encerrando com segurança.`
        );
        break;
      }

      for (const block of response.content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
          qualityGate = updateQualityGateEvidence(qualityGate, block.text);
        }
        else if (block.type === "tool_use")
          console.log(`\n  [tool: ${block.name}]`);
      }

      if (response.stop_reason === "end_turn") {
        await saveCheckpoint("Execução finalizada com end_turn.", "end_turn");
        finalStatus = "success";
        break;
      }

      if (response.stop_reason === "tool_use") {
        maxTokenRecoveries = 0;
        // Só adiciona o par (assistant + tool_results) quando o stop_reason é tool_use,
        // evitando mensagens sem tool_result correspondente (causa do 400)
        messages.push({ role: "assistant", content: response.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const toolInput = block.input as Record<string, unknown>;
            const cacheKey = getReplayCacheKey("reviewer", block.name, toolInput);

            let result: string;
            let replayed = false;
            if (ENABLE_REPLAY_SKIP && cacheKey) {
              const cached = toolProgressState.find(
                (entry) => entry.cacheKey === cacheKey && entry.status === "completed" && !!entry.cachedResult
              );
              if (cached?.cachedResult) {
                result = cached.cachedResult;
                replayed = true;
                console.log(`[reviewer] replay skip tool=${block.name} cacheKey=${cacheKey}`);
              } else {
                result = await executeTool(
                  block.name,
                  toolInput,
                  issueCache,
                  (statusName) => {
                    const guarded = enforceQualityGateTransition(qualityGate, statusName, [APPROVED_STATUS, REJECTED_STATUS]);
                    qualityGate = guarded.gate;
                    return guarded.blocked ? guarded.message ?? "Erro: QUALITY_GATE_REQUIRED" : null;
                  }
                );
              }
            } else {
              result = await executeTool(
                block.name,
                toolInput,
                issueCache,
                (statusName) => {
                  const guarded = enforceQualityGateTransition(qualityGate, statusName, [APPROVED_STATUS, REJECTED_STATUS]);
                  qualityGate = guarded.gate;
                  return guarded.blocked ? guarded.message ?? "Erro: QUALITY_GATE_REQUIRED" : null;
                }
              );
            }

            if (cacheKey) {
              const nextEntry = {
                toolName: block.name,
                status: (replayed ? "skipped" : "completed") as "skipped" | "completed",
                cacheKey,
                resultHash: `${result.length}:${result.slice(0, 64)}`,
                cachedResult: result.length <= REPLAY_MAX_CACHED_RESULT_CHARS ? result : undefined,
                skipReason: replayed ? "checkpoint_cache_hit" : undefined,
                replaySource: replayed ? ("checkpoint_cache" as const) : ("live" as const),
              };
              upsertToolProgressState(toolProgressState, cacheKey, nextEntry);
            }

            results.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }
        }
        messages.push({ role: "user", content: results });
        await saveCheckpoint("Tool chain executada; aguardando próximo turno.", "tool_use");
      } else if (response.stop_reason === "max_tokens") {
        maxTokenRecoveries++;
        if (maxTokenRecoveries > MAX_TOKEN_RECOVERIES) {
          await saveCheckpoint("Encerrado por limite de recuperações max_tokens.", "max_tokens_recovery_limit");
          console.log(
            `\n[reviewer] limite de recuperações por max_tokens atingido (${MAX_TOKEN_RECOVERIES}) — encerrando execução.`
          );
          break;
        }
        // Recuperação: mantém o histórico íntegro e pede continuação objetiva,
        // priorizando tool_use para evitar novo estouro por texto longo.
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text:
                "CONTINUE do ponto exato onde parou, sem repetir contexto. " +
                "Se faltar ação de ferramenta, responda apenas com o próximo tool_use necessário. " +
                "Evite texto longo; mantenha saídas objetivas.",
            },
          ],
        });
        await saveCheckpoint("Recuperação por max_tokens solicitada.", "max_tokens");
        continue;
      } else {
        await saveCheckpoint("Stop reason inesperado; execução interrompida.", `unexpected_${String(response.stop_reason)}`);
        // max_tokens ou stop_sequence — interrompe sem corromper o histórico
        console.log(`\n[reviewer] stop_reason inesperado: ${response.stop_reason}`);
        break;
      }
    }
  } finally {
    console.log(
      `\n[reviewer] ${issueKey} — status: ${finalStatus} | turnos: ${turns}` +
        ` | tokens in: ${inputTokens} out: ${outputTokens}` +
        ` cache_read: ${cacheReadTokens} cache_write: ${cacheCreationTokens}` +
        ` | prompt_mode: ${promptController.getMode()} switches: ${promptController.getSwitches()}`
    );

    if (rowId !== null) {
      await dbFinishSession(rowId, finalStatus);
    }
  }
}

export async function reviewIssue(issueKey: string, options?: AgentRunOptions): Promise<void> {
  console.log(`\n[reviewer] iniciando avaliação: ${issueKey}`);
  const rowId = await dbInsertSession("reviewer", issueKey, MODEL);
  await withRateLimit(() => doReview(issueKey, rowId, options));
}
