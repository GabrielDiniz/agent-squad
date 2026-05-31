import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { dbInsertSession, dbUpdateSession, dbFinishSession, type TokenUsage } from "../db.js";
import { jiraGetIssue, jiraUpdateIssueField, jiraTransitionToStatus, jiraAddComment } from "../jira.js";
import { withRateLimit, interTurnDelay } from "../retry.js";
import { calculateCostUsd } from "../cost.js";
import { resolveCodebases, type CodebaseEntry } from "../codebases.js";
import { ensureCodebaseCloned } from "../repository.js";
import {
  envFlag,
  getPromptAutoPolicyConfig,
  PromptModeController,
  resolvePromptModeSetting,
  type PromptMode,
} from "./prompt-policy.js";

const client = new Anthropic();

// Modelo específico do agente → global → default (sonnet: análise técnica de código)
const MODEL =
  process.env.CLAUDE_MODEL_ANALYST ??
  process.env.CLAUDE_MODEL ??
  "claude-sonnet-4-6";

const MAX_FILE_READS = 5;
const DONE_STATUS = process.env.JIRA_ANALYST_DONE_STATUS ?? "Pronto para Começar";
const MAX_OUTPUT_CHARS = Number(process.env.ANALYST_MAX_OUTPUT_CHARS ?? 3000);
const MAX_TURNS = Number(process.env.ANALYST_MAX_TURNS ?? 25);
const MAX_TOKENS_PER_TURN = Number(process.env.ANALYST_MAX_TOKENS_PER_TURN ?? 1536);
const MAX_TOKEN_RECOVERIES = Number(process.env.ANALYST_MAX_TOKEN_RECOVERIES ?? 3);
const MAX_TOTAL_TOKENS = Number(process.env.ANALYST_MAX_TOTAL_TOKENS ?? 40000);
const SOFT_BUDGET_RATIO = Number(process.env.ANALYST_SOFT_BUDGET_RATIO ?? 0.8);
const SOFT_MAX_TOKENS_PER_TURN = Number(
  process.env.ANALYST_SOFT_MAX_TOKENS_PER_TURN ?? Math.max(256, Math.floor(MAX_TOKENS_PER_TURN * 0.6))
);
const SNAPSHOT_INTERVAL = Number(process.env.ANALYST_SNAPSHOT_INTERVAL ?? 6);
const MAX_HISTORY_MESSAGES = Number(process.env.ANALYST_MAX_HISTORY_MESSAGES ?? 28);

const ENABLE_PROMPT_COMPACT = envFlag("ANALYST_ENABLE_PROMPT_COMPACT", false);
const ENABLE_SNAPSHOT = envFlag("ANALYST_ENABLE_SNAPSHOT", true);
const ENABLE_CACHE = envFlag("ANALYST_ENABLE_CACHE", true);
const ENABLE_BUDGET = envFlag("ANALYST_ENABLE_BUDGET", true);

const PROMPT_MODE_SETTING = resolvePromptModeSetting(process.env.ANALYST_PROMPT_MODE, ENABLE_PROMPT_COMPACT);
const PROMPT_AUTO_POLICY = getPromptAutoPolicyConfig("ANALYST");

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
    name: "list_codebases",
    description: "Lista os repositórios disponíveis com nome e descrição. Use para decidir quais são relevantes para a demanda.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_modules",
    description: "Lista os módulos de um codebase com nome, descrição e keywords de busca. Use após escolher o codebase para identificar os módulos relevantes e os termos a usar no grep/rg.",
    input_schema: {
      type: "object" as const,
      properties: {
        codebase: {
          type: "string",
          description: "Nome do codebase (obtido via list_codebases)",
        },
      },
      required: ["codebase"],
    },
  },
  {
    name: "bash_read",
    description: `Executa comandos read-only na raiz de um codebase. Comandos permitidos: find, grep, rg, ls, cat, head, tail, wc, sed. Use os keywords do módulo (obtidos via list_modules) como termos de busca no grep/rg. Máximo ${MAX_FILE_READS} leituras de arquivo (cat/head/tail) no total entre todos os codebases. Sintaxe rg: use -g '*.php' para filtrar por extensão (NÃO --include, que é flag do grep).`,
    input_schema: {
      type: "object" as const,
      properties: {
        codebase: {
          type: "string",
          description: "Nome do codebase (obtido via list_codebases)",
        },
        command: {
          type: "string",
          description: "Comando bash read-only. Ex: rg -l 'Marcacao|Regulacao' app/",
        },
      },
      required: ["codebase", "command"],
    },
  },
  {
    name: "jira_update_field",
    description: "Preenche o campo de solução técnica do issue com a proposta elaborada (em Markdown).",
    input_schema: {
      type: "object" as const,
      properties: {
        issue_key: { type: "string" },
        content: { type: "string", description: "Proposta técnica completa em Markdown" },
      },
      required: ["issue_key", "content"],
    },
  },
  {
    name: "jira_add_comment",
    description: "Adiciona um comentário a um issue do Jira. Use obrigatoriamente quando houver erro de clone ou acesso ao repositório, descrevendo o problema e possíveis causas.",
    input_schema: {
      type: "object" as const,
      properties: {
        issue_key: { type: "string" },
        comment: { type: "string", description: "Comentário em Markdown" },
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
}

// sed -n 'X,Yp' é read-only e permite leitura eficiente de intervalos de linhas
const ALLOWED_CMD = /^(find|grep|rg|ls|cat|head|tail|wc|sed)\b/;

/**
 * Extrai o caminho de arquivo do último argumento não-flag do comando (best-effort).
 * Usado para rastrear acessos por arquivo (melhorias C e D).
 */
function extractLastFilePath(cmd: string): string | null {
  const tokens = cmd.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i] ?? "";
    if (!t || t.startsWith("-")) continue;           // flags (-n, -l, …)
    if (/^['"]/.test(t)) continue;                   // padrões entre aspas ('pattern')
    if (t.includes("*") || t.includes("{")) continue; // globs
    if (t.length > 2 && (t.includes("/") || t.includes("."))) return t;
  }
  return null;
}

function execBashRead(
  codebaseName: string,
  cmd: string,
  codebases: CodebaseEntry[],
  fileReadCount: { n: number },
  fileAccessCount: Map<string, number>
): string {
  const entry = codebases.find((c) => c.name === codebaseName);
  if (!entry) {
    const available = codebases.map((c) => c.name).join(", ");
    return `Erro: codebase "${codebaseName}" não encontrado. Disponíveis: ${available}`;
  }

  const trimmed = cmd.trim();
  if (!ALLOWED_CMD.test(trimmed)) {
    return "Erro: comando não permitido. Use apenas: find, grep, rg, ls, cat, head, tail, wc, sed";
  }

  const isFileRead = /^(cat|head|tail)\b/.test(trimmed);
  if (isFileRead) {
    if (fileReadCount.n >= MAX_FILE_READS) {
      return `Erro: limite de ${MAX_FILE_READS} leituras de arquivo atingido. Use sed -n 'X,Yp' ou grep/rg para buscas adicionais.`;
    }
    fileReadCount.n++;
  }

  // C + D: rastreia acesso por arquivo
  const rawPath = extractLastFilePath(trimmed);
  const absPath = rawPath ? path.resolve(entry.path, rawPath) : null;
  let prefix = "";
  if (absPath) {
    const count = (fileAccessCount.get(absPath) ?? 0) + 1;
    fileAccessCount.set(absPath, count);
    if (count === 1) {
      // D: informa tamanho na primeira leitura — orienta uso de sed -n
      try {
        const wc = execSync(`wc -l "${absPath}"`, { encoding: "utf-8", timeout: 3_000 }).trim();
        const lines = wc.split(/\s+/)[0];
        prefix = `[Arquivo: ${lines} linhas — prefira sed -n 'X,Yp' para leituras parciais]\n`;
      } catch { /* ignora se for diretório ou não existir */ }
    } else if (count >= 3) {
      // C: alerta sobre leituras repetidas no mesmo arquivo
      prefix = `⚠ Este arquivo foi acessado ${count}× — consolide as leituras necessárias e prossiga.\n`;
    }
  }

  try {
    const output = execSync(trimmed, {
      cwd: entry.path,
      timeout: 10_000,
      maxBuffer: 1024 * 256,
      encoding: "utf-8",
    });
    const raw = output.length > MAX_OUTPUT_CHARS
      ? output.slice(0, MAX_OUTPUT_CHARS) + "\n[...truncado]"
      : output;
    return prefix ? prefix + raw : raw;
  } catch (err: any) {
    const msg = (err.stdout as string | undefined) || err.message || String(err);
    return `Erro: ${String(msg)}`.slice(0, 500);
  }
}

function buildPrompt(issueKey: string, mode: PromptMode): string {
  if (mode === "compact") {
    return `Você é um analista técnico sênior.
Analise a demanda ${issueKey} e produza solução técnica objetiva.

Passos:
1. Buscar issue no Jira.
2. Identificar codebases relevantes com list_codebases.
3. Identificar módulos relevantes com list_modules.
4. Explorar código com preferência por grep/rg + sed -n (evite leituras completas desnecessárias).
5. Elaborar proposta técnica em Markdown com: resumo, módulos/codebases, arquivos a alterar/criar, passos de implementação e riscos/testes.
6. Preencher o campo técnico (jira_update_field) e transitar para "${DONE_STATUS}".

Se houver erro de clone/autenticação/acesso, comentar no Jira via jira_add_comment e encerrar.
Quando precisar agir, responda com tool_use diretamente.`;
  }

  if (mode === "deep") {
   return `Você é um analista técnico sênior para demandas de maior complexidade.
Demanda alvo: ${issueKey}.

Objetivo:
- produzir solução técnica implementável, com baixo retrabalho e uso eficiente de tokens.

Fluxo obrigatório:
1. Buscar issue no Jira.
2. Delimitar escopo técnico: contexto, restrições e pontos de dúvida.
3. Mapear codebases/módulos relevantes com list_codebases/list_modules.
4. Investigar código em camadas:
  - localização (rg/grep)
  - leitura seletiva (sed -n)
  - evidências dos pontos de mudança.
5. Para cada mudança proposta, explicitar:
  - impacto funcional
  - impacto técnico (dependências/integrações)
  - risco principal e mitigação.
6. Publicar technical spec em Markdown via jira_update_field.
7. Transitar issue para "${DONE_STATUS}".

Regras de eficiência:
- use tool_use sempre que houver ação pendente;
- evite releitura redundante de arquivos;
- prefira saídas curtas e estruturadas.

Se houver erro de acesso/clone, comentar no Jira imediatamente e encerrar a execução.`;
  }

  return `Você é um analista técnico sênior. Analise a demanda ${issueKey} do Jira e proponha uma solução técnica para a equipe de desenvolvimento.

## Passos obrigatórios

1. **Buscar** os detalhes completos da demanda ${issueKey} no Jira.

2. **Identificar os codebases relevantes**: use list_codebases e selecione os repositórios que se aplicam ao contexto da demanda.

3. **Identificar os módulos relevantes**: para cada codebase selecionado, use list_modules. Cada módulo retorna keywords — use-os como termos de busca no grep/rg para localizar os arquivos certos.

4. **Explorar o código**:
   - Use rg ou grep com os keywords do módulo para encontrar controllers, models, services e rotas relacionados
   - Use find e ls para confirmar estrutura quando necessário
   - **Máximo ${MAX_FILE_READS} leituras completas de arquivo** (cat/head/tail) no total — escolha apenas os mais relevantes
   - **Disciplina de leitura — siga esta sequência por arquivo:**
     1. \`grep -n\` ou \`rg -n\` para localizar a linha exata
     2. \`sed -n 'INICIO,FIMp'\` para ler apenas o trecho relevante (±15 linhas do ponto de interesse)
     3. Nunca use \`cat\` em arquivos com mais de 100 linhas — prefira \`sed -n\`
     4. **Cada arquivo deve ser lido no máximo uma vez** — combine todas as informações necessárias em uma única leitura com sed. Ao acessar um arquivo a primeira vez, o sistema informa o número total de linhas.

5. **Elaborar** a proposta técnica contendo:
   - **Resumo da solução** (2–3 frases)
   - **Codebases e módulos envolvidos** (com justificativa)
   - **Arquivos a modificar** (caminho relativo + descrição da mudança)
   - **Novos arquivos a criar** (se necessário)
   - **Passos de implementação** (ordenados, concisos)
   - **Pontos de atenção** (dependências entre módulos/serviços, riscos, testes)

6. **Preencher** o campo de solução técnica do issue ${issueKey} (jira_update_field) com a proposta elaborada.

7. **Transitar** o status do issue para "${DONE_STATUS}".

## Tratamento de erros de acesso ao código

Se ao tentar acessar qualquer codebase (list_modules, bash_read) ocorrer um erro de clone, autenticação ou acesso ao repositório:
1. **Poste imediatamente um comentário** no issue ${issueKey} via \`jira_add_comment\` com:
   - Descrição clara do erro recebido
   - Possíveis causas (credenciais inválidas/ausentes, URL errada, permissão negada, timeout, etc.)
   - Orientação para corrigir e re-enfileirar a demanda
2. Não tente prosseguir com a análise sem o código — encerre após postar o comentário.

Seja específico: cite nomes de classes, métodos, rotas e padrões já adotados no projeto.
Tom: técnico e direto. Escreva em português.

Regras de eficiência:
- quando houver ação pendente, priorize tool_use;
- reduza texto narrativo sem perda de precisão técnica;
- não repita contexto já consolidado.

Formate o comentário em **Markdown** (será convertido automaticamente para Jira):
use ## para seções, **negrito** para destaques, - para listas, 1. para listas numeradas e \`\`\`php para blocos de código.`;
}

/**
 * Ponto 3 de cache: rolling cache — antes de cada chamada à API, marca o último
 * bloco do último user message com cache_control: ephemeral.
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

function compactHistory(messages: Anthropic.MessageParam[], snapshotText: string): void {
  if (messages.length <= MAX_HISTORY_MESSAGES) return;

  const tailStart = Math.max(1, messages.length - (MAX_HISTORY_MESSAGES - 2));
  const tail = messages.slice(tailStart);
  while (tail.length > 0 && isToolResultMessage(tail[0])) tail.shift();

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

async function doAnalysis(issueKey: string, rowId: number | null, options?: AgentRunOptions): Promise<void> {
  const promptController = new PromptModeController(PROMPT_MODE_SETTING, PROMPT_AUTO_POLICY);
  const codebases = resolveCodebases();
  async function resolveCodebaseOrError(codebaseName: string): Promise<CodebaseEntry> {
    const entry = codebases.find((c) => c.name === codebaseName);
    if (!entry) {
      const available = codebases.map((c) => c.name).join(", ");
      throw new Error(`Codebase "${codebaseName}" não encontrado. Disponíveis: ${available}`);
    }
    try {
      await ensureCodebaseCloned(entry);
    } catch (cloneErr) {
      const msg = String(cloneErr);
      const comment =
        `## ⚠️ Erro de acesso ao repositório\n\n` +
        `O agente analista não conseguiu acessar o codebase **${codebaseName}** necessário para analisar esta demanda.\n\n` +
        `**Erro:**\n\`\`\`\n${msg}\n\`\`\`\n\n` +
        `**Possíveis causas:**\n` +
        `- Credenciais Git ausentes ou expiradas (verifique \`GIT_TOKEN\` / \`GIT_USER\`/\`GIT_PASSWORD\` nas variáveis de ambiente)\n` +
        `- URL do repositório incorreta ou inacessível (verifique \`repository_url\` em codebases.json)\n` +
        `- Repositório privado sem permissão de leitura para o token configurado\n` +
        `- Falha de rede ou timeout ao clonar (verifique conectividade e \`CODEBASE_CLONE_TIMEOUT_MS\`)\n` +
        `- Caminho local do codebase sem permissão de escrita (verifique \`CODEBASES_ROOT\`)\n\n` +
        `Corrija o problema e re-enfileire a demanda.`;
      try {
        await jiraAddComment(issueKey, comment);
        console.warn(`[analyst] ${issueKey}: comentário de erro de clone postado para "${codebaseName}"`);
      } catch (commentErr) {
        console.warn(`[analyst] aviso: não foi possível postar comentário de erro: ${commentErr}`);
      }
      throw cloneErr;
    }
    return entry;
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      // Ponto 2 de cache: prompt inicial fixo por issue
      content: [
        {
          type: "text",
          text: buildPrompt(issueKey, promptController.getMode()),
          ...(ENABLE_CACHE ? { cache_control: { type: "ephemeral" } as any } : {}),
        },
      ],
    },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let turns = 0;
  let finalStatus = "error";
  const fileReadCount = { n: 0 };
  const fileAccessCount = new Map<string, number>(); // C+D: acessos por arquivo
  let lastHeaders: { get(name: string): string | null } | null = null;
  let maxTokenRecoveries = 0;
  let softBudgetMode = false;
  let hardBudgetExceeded = false;
  let hardBudgetCommentPosted = false;
  const issueCache = new Map<string, string>();
  const codebasesCache = new Map<string, string>();
  const modulesCache = new Map<string, string>();

  try {
    while (turns < MAX_TURNS) {
      if (options?.checkpoint) {
        await options.checkpoint();
      }
      if (turns > 0 && lastHeaders) {
        await interTurnDelay("analyst", lastHeaders);
      }
      turns++;

      if (ENABLE_SNAPSHOT && turns > 1 && turns % SNAPSHOT_INTERVAL === 0) {
        compactHistory(
          messages,
          `SNAPSHOT analyst: turn=${turns}; tokens_in=${inputTokens}; tokens_out=${outputTokens}; ` +
            `file_reads=${fileReadCount.n}; continue do estado atual sem repetir conteúdo.`
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
      if (modeDecision.switched && modeDecision.switchInstruction) {
        console.log(`\n[analyst] prompt mode -> ${modeDecision.mode} (${modeDecision.reason})`);
        messages.push({
          role: "user",
          content: [{ type: "text", text: modeDecision.switchInstruction }],
        });
      }

      if (ENABLE_BUDGET && MAX_TOTAL_TOKENS > 0 && tokensBeforeCall >= MAX_TOTAL_TOKENS) {
        hardBudgetExceeded = true;
        console.log(`\n[analyst] orçamento hard de tokens atingido antes da chamada (${tokensBeforeCall}/${MAX_TOTAL_TOKENS}).`);
        break;
      }

      const currentMaxTokensPerTurn = ENABLE_BUDGET && softBudgetMode
        ? Math.min(MAX_TOKENS_PER_TURN, SOFT_MAX_TOKENS_PER_TURN)
        : MAX_TOKENS_PER_TURN;

      const { data: response, response: httpResponse } =
        await client.messages.create({
          model: MODEL,
          max_tokens: currentMaxTokensPerTurn,
          tools: TOOLS,
          messages,
        }).withResponse();

      lastHeaders = httpResponse.headers;

      const u = response.usage as any;
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      cacheReadTokens += u.cache_read_input_tokens ?? 0;
      cacheCreationTokens += u.cache_creation_input_tokens ?? 0;

      // Persiste acumulados após cada turno — garante dados mesmo em caso de interrupção
      if (rowId !== null) {
        const usage: TokenUsage = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
        const codebaseNames = codebases.map((c) => c.name).join(", ");
        void dbUpdateSession(rowId, turns, calculateCostUsd(MODEL, usage), usage, codebaseNames);
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
          `\n[analyst] orçamento soft ativado (${totalBudgetTokens}/${MAX_TOTAL_TOKENS}) — modo econômico.`
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
        hardBudgetExceeded = true;
        console.log(
          `\n[analyst] orçamento hard de tokens atingido (${totalBudgetTokens}/${MAX_TOTAL_TOKENS}) — encerrando com segurança.`
        );
        break;
      }

      for (const block of response.content) {
        if (block.type === "text") process.stdout.write(block.text);
        else if (block.type === "tool_use")
          console.log(`\n  [tool: ${block.name}(${JSON.stringify(block.input).slice(0, 100)})]`);
      }

      if (response.stop_reason === "end_turn") {
        finalStatus = "success";
        break;
      }

      if (response.stop_reason === "tool_use") {
        maxTokenRecoveries = 0;
        messages.push({ role: "assistant", content: response.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const inp = block.input as Record<string, unknown>;
            let result: string;
            try {
              if (block.name === "jira_get_issue") {
                const issueKeyReq = inp.issue_key as string;
                if (ENABLE_CACHE && issueCache.has(issueKeyReq)) {
                  result = "Cache hit jira_get_issue: use os detalhes já retornados anteriormente nesta execução.";
                } else {
                  result = await jiraGetIssue(issueKeyReq);
                  if (ENABLE_CACHE) issueCache.set(issueKeyReq, result);
                }
              } else if (block.name === "list_codebases") {
                const cacheKey = "list_codebases";
                if (ENABLE_CACHE && codebasesCache.has(cacheKey)) {
                  result = "Cache hit list_codebases: use os repositórios já listados nesta execução.";
                } else {
                  result = JSON.stringify(
                    codebases.map((c) => ({
                      name: c.name,
                      description: c.description,
                      path: c.path,
                      repositoryUrl: c.repositoryUrl ?? null,
                      localReady: existsSync(path.join(c.path, ".git")),
                    })),
                    null,
                    2
                  );
                  if (ENABLE_CACHE) codebasesCache.set(cacheKey, result);
                }
              } else if (block.name === "list_modules") {
                const entry = await resolveCodebaseOrError(inp.codebase as string);
                const moduleKey = String(inp.codebase);
                if (ENABLE_CACHE && modulesCache.has(moduleKey)) {
                  result = `Cache hit list_modules(${moduleKey}): use os módulos já retornados nesta execução.`;
                } else if (!entry.modules?.length) {
                  result = `Codebase "${inp.codebase}" não possui módulos definidos. Explore diretamente com bash_read.`;
                } else {
                  result = JSON.stringify(
                    entry.modules.map((m) => ({
                      name: m.name,
                      description: m.description,
                      keywords: m.keywords ?? [],
                    })),
                    null,
                    2
                  );
                  if (ENABLE_CACHE) modulesCache.set(moduleKey, result);
                }
              } else if (block.name === "bash_read") {
                await resolveCodebaseOrError(inp.codebase as string);
                result = execBashRead(
                  inp.codebase as string,
                  inp.command as string,
                  codebases,
                  fileReadCount,
                  fileAccessCount
                );
              } else if (block.name === "jira_update_field") {
                const fieldId = process.env.JIRA_ANALYST_FIELD_ID ?? "";
                if (!fieldId) {
                  result = "Erro: JIRA_ANALYST_FIELD_ID não configurado.";
                } else {
                  await jiraUpdateIssueField(inp.issue_key as string, fieldId, inp.content as string);
                  result = "Campo de solução técnica preenchido.";
                }
              } else if (block.name === "jira_add_comment") {
                await jiraAddComment(inp.issue_key as string, inp.comment as string);
                result = "Comentário adicionado.";
              } else if (block.name === "jira_transition_issue") {
                result = await jiraTransitionToStatus(inp.issue_key as string, inp.status_name as string);
              } else {
                result = `Tool desconhecida: ${block.name}`;
              }
            } catch (err) {
              result = `Erro: ${String(err)}`;
            }
            results.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }
        }
        messages.push({ role: "user", content: results });
      } else if (response.stop_reason === "max_tokens") {
        maxTokenRecoveries++;
        if (maxTokenRecoveries > MAX_TOKEN_RECOVERIES) {
          console.log(
            `\n[analyst] limite de recuperações por max_tokens atingido (${MAX_TOKEN_RECOVERIES}) — encerrando execução.`
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
        continue;
      } else {
        console.log(`\n[analyst] stop_reason inesperado: ${response.stop_reason}`);
        break;
      }
    }
  } finally {
    if (ENABLE_BUDGET && hardBudgetExceeded && !hardBudgetCommentPosted) {
      const comment =
        `## ⚠️ Execução interrompida por orçamento de tokens\n\n` +
        `O agente analista interrompeu a execução ao atingir o limite hard de tokens configurado.\n\n` +
        `**Limite configurado:** \`${MAX_TOTAL_TOKENS}\` tokens\n` +
        `**Ação recomendada:** aumentar os limites \`ANALYST_MAX_TOTAL_TOKENS\`/\`ANALYST_MAX_TOKENS_PER_TURN\` ` +
        `ou reexecutar a demanda para continuidade.`;
      try {
        await jiraAddComment(issueKey, comment);
        hardBudgetCommentPosted = true;
      } catch (err) {
        console.warn(`[analyst] aviso: não foi possível postar comentário de orçamento hard: ${err}`);
      }
    }

    console.log(
      `\n[analyst] ${issueKey} — status: ${finalStatus} | turnos: ${turns}` +
        ` | tokens in: ${inputTokens} out: ${outputTokens}` +
        ` cache_read: ${cacheReadTokens} cache_write: ${cacheCreationTokens}` +
        ` | file_reads: ${fileReadCount.n}/${MAX_FILE_READS} unique_files: ${fileAccessCount.size}` +
        ` | prompt_mode: ${promptController.getMode()} switches: ${promptController.getSwitches()}`
    );

    if (rowId !== null) {
      await dbFinishSession(rowId, finalStatus);
    }
  }
}

export async function analyzeIssue(issueKey: string, options?: AgentRunOptions): Promise<void> {
  console.log(`\n[analyst] iniciando análise técnica: ${issueKey}`);
  const rowId = await dbInsertSession("analyst", issueKey, MODEL);
  await withRateLimit(() => doAnalysis(issueKey, rowId, options));
}
