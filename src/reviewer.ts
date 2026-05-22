import Anthropic from "@anthropic-ai/sdk";
import { dbInsertSession, dbFinishSession, type TokenUsage } from "./db.js";
import { jiraGetIssue, jiraAddComment, jiraTransitionToStatus } from "./jira.js";
import { withRateLimit } from "./retry.js";

const client = new Anthropic();

const APPROVED_STATUS = process.env.JIRA_APPROVED_STATUS ?? "Aprovado";
const REJECTED_STATUS = process.env.JIRA_REJECTED_STATUS ?? "Rascunho";

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
  },
];

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    if (name === "jira_get_issue") return await jiraGetIssue(input.issue_key as string);
    if (name === "jira_add_comment") {
      await jiraAddComment(input.issue_key as string, input.comment as string);
      return "Comentário adicionado.";
    }
    if (name === "jira_transition_issue") {
      return await jiraTransitionToStatus(input.issue_key as string, input.status_name as string);
    }
    return `Tool desconhecida: ${name}`;
  } catch (err) {
    return `Erro: ${String(err)}`;
  }
}

function buildPrompt(issueKey: string): string {
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

Tom do comentário: colaborativo, não punitivo. O objetivo é ajudar o analista a melhorar a história.`;
}

async function doReview(issueKey: string, rowId: number | null): Promise<void> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildPrompt(issueKey) },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let turns = 0;
  let finalStatus = "error";

  try {
    while (turns < 10) {
      turns++;

      const response = await client.messages.create({
        model: process.env.CLAUDE_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        tools: TOOLS,
        messages,
      });

      const u = response.usage as any;
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      cacheReadTokens += u.cache_read_input_tokens ?? 0;
      cacheCreationTokens += u.cache_creation_input_tokens ?? 0;

      for (const block of response.content) {
        if (block.type === "text") process.stdout.write(block.text);
        else if (block.type === "tool_use")
          console.log(`\n  [tool: ${block.name}]`);
      }

      if (response.stop_reason === "end_turn") {
        finalStatus = "success";
        break;
      }

      if (response.stop_reason === "tool_use") {
        // Só adiciona o par (assistant + tool_results) quando o stop_reason é tool_use,
        // evitando mensagens sem tool_result correspondente (causa do 400)
        messages.push({ role: "assistant", content: response.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const result = await executeTool(block.name, block.input as Record<string, unknown>);
            results.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }
        }
        messages.push({ role: "user", content: results });
      } else {
        // max_tokens ou stop_sequence — interrompe sem corromper o histórico
        console.log(`\n[reviewer] stop_reason inesperado: ${response.stop_reason}`);
        break;
      }
    }
  } finally {
    const usage: TokenUsage = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };

    console.log(
      `\n[reviewer] ${issueKey} — status: ${finalStatus} | turnos: ${turns}` +
        ` | tokens in: ${inputTokens} out: ${outputTokens}` +
        ` cache_read: ${cacheReadTokens} cache_write: ${cacheCreationTokens}`
    );

    if (rowId !== null) {
      await dbFinishSession(rowId, "", finalStatus, turns, 0, usage);
    }
  }
}

export async function reviewIssue(issueKey: string): Promise<void> {
  console.log(`\n[reviewer] iniciando avaliação: ${issueKey}`);
  const rowId = await dbInsertSession(`review:${issueKey}`);
  await withRateLimit(() => doReview(issueKey, rowId));
}
