import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { dbInsertSession, dbUpdateSession, dbFinishSession, type TokenUsage } from "../db.js";
import { jiraGetIssue, jiraTransitionToStatus, jiraAddComment } from "../jira.js";
import { withRateLimit, interTurnDelay } from "../retry.js";
import { calculateCostUsd } from "../cost.js";
import { buildAuthenticatedUrl, createPullRequest } from "../git.js";
import { resolveCodebases, type CodebaseEntry } from "../codebases.js";
import { ensureCodebaseCloned } from "../repository.js";

const client = new Anthropic();
const MAX_FILE_READS = 10;
const MAX_OUTPUT_CHARS = 12_000; // aumentado: arquivos PHP/JRXML grandes precisam de mais espaço
// Modelo específico do agente → global → default (sonnet: geração de código completo)
const MODEL =
  process.env.CLAUDE_MODEL_IMPLEMENTOR ??
  process.env.CLAUDE_MODEL ??
  "claude-sonnet-4-6";

const START_STATUS = process.env.JIRA_IMPLEMENTOR_START_STATUS ?? "Em andamento";
const DONE_STATUS  = process.env.JIRA_IMPLEMENTOR_DONE_STATUS  ?? "Code Review";
const ERROR_STATUS = process.env.JIRA_IMPLEMENTOR_ERROR_STATUS ?? "Pausado";

export interface AgentRunOptions {
  checkpoint?: () => Promise<void>;
}

// ─── bash_read ────────────────────────────────────────────────────────────────

// sed -n 'X,Yp' é read-only e essencial para ler intervalos de linhas em arquivos grandes
const ALLOWED_READ_CMD = /^(find|grep|rg|ls|cat|head|tail|wc|sed)\b/;

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
    return `Erro: codebase "${codebaseName}" não encontrado. Disponíveis: ${codebases.map((c) => c.name).join(", ")}`;
  }

  const trimmed = cmd.trim();
  if (!ALLOWED_READ_CMD.test(trimmed)) {
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
      // D: informa tamanho na primeira leitura — orienta uso de sed -n e patch_file
      try {
        const wc = execSync(`wc -l "${absPath}"`, { encoding: "utf-8", timeout: 3_000 }).trim();
        const lines = wc.split(/\s+/)[0];
        prefix = `[Arquivo: ${lines} linhas — use sed -n 'X,Yp' para ler trechos; patch_file para edições cirúrgicas]\n`;
      } catch { /* ignora se for diretório ou não existir */ }
    } else if (count >= 3) {
      // C: alerta sobre leituras repetidas no mesmo arquivo
      prefix = `⚠ Este arquivo foi acessado ${count}× — consolide as leituras necessárias e prossiga com patch_file.\n`;
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

// ─── bash_exec helpers ────────────────────────────────────────────────────────

// Each segment of a '&&' chain must start with git or gh
const ALLOWED_EXEC_CMD = /^(git|gh)\b/;

// Shell operators that could escape the git/gh restriction
const SHELL_INJECTION = /[|`;]|\$\(/;

/** Extracts a readable error message from a caught execSync error. */
function fmtErr(err: any): string {
  const stderr = ((err.stderr as string | undefined) ?? "").trim();
  return stderr || err.message || String(err);
}

/**
 * Temporarily rewrites origin's remote URL to include credentials, calls fn(),
 * then restores the original URL in a finally block.
 * For SSH remotes (or missing creds) the URL is left unchanged.
 */
function withRemoteAuth<T>(cwd: string, fn: () => T): T {
  let savedUrl: string | null = null;
  try {
    const origUrl = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    const authUrl = buildAuthenticatedUrl(origUrl);
    if (authUrl && authUrl !== origUrl) {
      savedUrl = origUrl;
      spawnSync("git", ["remote", "set-url", "origin", authUrl], { cwd });
    }
  } catch {
    /* no remote or no creds — proceed as-is */
  }
  try {
    return fn();
  } finally {
    if (savedUrl) {
      spawnSync("git", ["remote", "set-url", "origin", savedUrl], { cwd });
    }
  }
}

/**
 * Guarantees the local working tree is on the latest master before a feature
 * branch is created:
 *   1. git checkout -f master  (force: discards any leftover local changes)
 *   2. git fetch origin master  (with auth injection)
 *   3. git reset --hard origin/master
 *
 * Non-fatal: if any step fails it is logged but execution continues so the
 * branch is still created from whatever local master exists.
 */
function syncToMaster(cwd: string): string {
  const log: string[] = [];

  // Step 1 — switch to master, discarding any uncommitted leftovers from a
  // previous (possibly failed) run
  try {
    execSync("git checkout -f master", { cwd, encoding: "utf-8", timeout: 10_000 });
    log.push("checkout master ok");
  } catch (err) {
    log.push(`checkout: ${fmtErr(err)}`);
    return `[sync master] ${log.join(" | ")}`;
  }

  // Step 2 — fetch latest master from remote (auth injected)
  try {
    withRemoteAuth(cwd, () =>
      execSync("git fetch origin master", { cwd, encoding: "utf-8", timeout: 30_000 })
    );
    log.push("fetch ok");
  } catch (err) {
    log.push(`fetch: ${fmtErr(err)}`);
    // Non-fatal: reset will use whatever origin/master is cached locally
  }

  // Step 3 — align local master with fetched origin/master
  try {
    execSync("git reset --hard origin/master", { cwd, encoding: "utf-8", timeout: 10_000 });
    log.push("reset --hard ok");
  } catch (err) {
    log.push(`reset: ${fmtErr(err)}`);
  }

  return `[sync master] ${log.join(" | ")}`;
}

// ─── bash_exec ────────────────────────────────────────────────────────────────

function execBashExec(
  codebaseName: string,
  cmd: string,
  codebases: CodebaseEntry[]
): string {
  const entry = codebases.find((c) => c.name === codebaseName);
  if (!entry) {
    return `Erro: codebase "${codebaseName}" não encontrado. Disponíveis: ${codebases.map((c) => c.name).join(", ")}`;
  }

  const trimmed = cmd.trim();

  // Block shell injection vectors
  if (SHELL_INJECTION.test(trimmed)) {
    return "Erro: operadores de shell não permitidos (|, ;, `, $()). Execute comandos separadamente.";
  }

  // Each segment of a '&&' chain must be an allowed command
  const segments = trimmed.split(/\s*&&\s*/);
  for (const seg of segments) {
    if (!ALLOWED_EXEC_CMD.test(seg.trim())) {
      return `Erro: "${seg.trim()}" não é um comando git/gh permitido.`;
    }
  }

  // Evita criação de PR via GH CLI (gh pr create), pois esse fluxo depende de
  // permissões GraphQL variáveis por token/organização e quebra com frequência.
  // Padronizamos abertura de PR/MR na tool create_pull_request.
  if (/^gh\s+pr\s+create\b/i.test(trimmed)) {
    return "Erro: use a tool create_pull_request para abrir PR/MR (gh pr create desabilitado).";
  }

  // Before creating a feature branch: sync local master to origin/master,
  // then force-delete any existing branch with the same name so reruns are clean.
  if (/^git\s+checkout\s+-[bB]\b/.test(trimmed)) {
    const syncMsg = syncToMaster(entry.path);
    console.log(`[implementor] ${codebaseName}: ${syncMsg}`);

    const branchMatch = trimmed.match(/git\s+checkout\s+-[bB]\s+(\S+)/);
    const branchName = branchMatch?.[1];
    if (branchName) {
      try {
        execSync(`git branch -D ${branchName}`, {
          cwd: entry.path,
          encoding: "utf-8",
          timeout: 5_000,
        });
        console.log(`[implementor] ${codebaseName}: branch "${branchName}" deletada (rerun limpo)`);
      } catch {
        // Branch doesn't exist yet — nothing to delete
      }
    }
  }

  const execOpts = {
    cwd: entry.path,
    timeout: 60_000,
    maxBuffer: 1024 * 512,
    encoding: "utf-8" as const,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME:     process.env.GIT_USER_NAME  ?? "Agent Bot",
      GIT_AUTHOR_EMAIL:    process.env.GIT_USER_EMAIL ?? "agent@bot.local",
      GIT_COMMITTER_NAME:  process.env.GIT_USER_NAME  ?? "Agent Bot",
      GIT_COMMITTER_EMAIL: process.env.GIT_USER_EMAIL ?? "agent@bot.local",
      GH_TOKEN:     process.env.GH_TOKEN ?? "",
      GITHUB_TOKEN: process.env.GH_TOKEN ?? "",
    },
  };

  // Wrap network operations with auth injection
  const needsRemoteAuth = /^git\s+(push|pull|fetch|clone)\b/.test(trimmed);

  try {
    const output = needsRemoteAuth
      ? withRemoteAuth(entry.path, () => execSync(trimmed, execOpts))
      : execSync(trimmed, execOpts);

    const out = output.trim();
    return out.length > MAX_OUTPUT_CHARS
      ? out.slice(0, MAX_OUTPUT_CHARS) + "\n[...truncado]"
      : out || "(comando executado com sucesso)";
  } catch (err: any) {
    const stdout = ((err.stdout as string | undefined) ?? "").trim();
    const stderr = ((err.stderr as string | undefined) ?? "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n");
    return `Erro: ${combined || err.message || String(err)}`.slice(0, 800);
  }
}

// ─── write_file ───────────────────────────────────────────────────────────────

function execWriteFile(
  codebaseName: string,
  relativePath: string,
  content: string,
  codebases: CodebaseEntry[]
): string {
  const entry = codebases.find((c) => c.name === codebaseName);
  if (!entry) {
    return `Erro: codebase "${codebaseName}" não encontrado. Disponíveis: ${codebases.map((c) => c.name).join(", ")}`;
  }

  const base = path.resolve(entry.path);
  const absolute = path.resolve(base, relativePath);

  // Path traversal prevention
  if (!absolute.startsWith(base + path.sep) && absolute !== base) {
    return "Erro: caminho fora do diretório do codebase.";
  }

  try {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf-8");
    return `Arquivo escrito: ${relativePath} (${content.length} bytes)`;
  } catch (err: any) {
    return `Erro ao escrever arquivo: ${err.message}`;
  }
}

// ─── patch_file ───────────────────────────────────────────────────────────────

/**
 * Substitui um intervalo de linhas de um arquivo existente.
 * Preferível ao write_file para modificações cirúrgicas em arquivos grandes.
 */
function execPatchFile(
  codebaseName: string,
  relativePath: string,
  startLine: number,
  endLine: number,
  content: string,
  codebases: CodebaseEntry[]
): string {
  const entry = codebases.find((c) => c.name === codebaseName);
  if (!entry) {
    return `Erro: codebase "${codebaseName}" não encontrado. Disponíveis: ${codebases.map((c) => c.name).join(", ")}`;
  }

  const base = path.resolve(entry.path);
  const absolute = path.resolve(base, relativePath);

  if (!absolute.startsWith(base + path.sep) && absolute !== base) {
    return "Erro: caminho fora do diretório do codebase.";
  }

  try {
    const original = readFileSync(absolute, "utf-8");
    const lines = original.split("\n");
    const totalLines = lines.length;

    if (startLine < 1 || endLine < startLine || endLine > totalLines) {
      return `Erro: intervalo ${startLine}–${endLine} inválido. O arquivo tem ${totalLines} linhas.`;
    }

    const newLines = content.split("\n");
    const patched = [
      ...lines.slice(0, startLine - 1),
      ...newLines,
      ...lines.slice(endLine),
    ];

    writeFileSync(absolute, patched.join("\n"), "utf-8");

    const replaced = endLine - startLine + 1;
    return (
      `Patch aplicado: ${relativePath} — linhas ${startLine}–${endLine} ` +
      `(${replaced} → ${newLines.length} linhas). Total agora: ${patched.length} linhas.`
    );
  } catch (err: any) {
    return `Erro ao aplicar patch: ${err.message}`;
  }
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "jira_get_issue",
    description: "Busca detalhes de um issue do Jira incluindo título, descrição, critérios de aceite e especificação técnica (technical_spec).",
    input_schema: {
      type: "object" as const,
      properties: { issue_key: { type: "string" } },
      required: ["issue_key"],
    },
  },
  {
    name: "list_codebases",
    description: "Lista os repositórios disponíveis com nome e descrição.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_modules",
    description: "Lista os módulos de um codebase com nome, descrição e keywords de busca.",
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
    description: `Executa comandos read-only na raiz de um codebase. Comandos: find, grep, rg, ls, cat, head, tail, wc, sed. Máximo ${MAX_FILE_READS} leituras de arquivo (cat/head/tail). Sintaxe rg: use -g '*.php' para filtrar por extensão (NÃO --include, que é flag do grep). Sempre leia um arquivo antes de modificá-lo.`,
    input_schema: {
      type: "object" as const,
      properties: {
        codebase: { type: "string" },
        command: {
          type: "string",
          description: "Ex: cat app/Http/Controllers/RegulacaoController.php",
        },
      },
      required: ["codebase", "command"],
    },
  },
  {
    name: "write_file",
    description: "Cria um novo arquivo ou sobrescreve completamente um arquivo pequeno (até ~150 linhas). Para modificar arquivos existentes maiores, prefira patch_file.",
    input_schema: {
      type: "object" as const,
      properties: {
        codebase: { type: "string" },
        relative_path: {
          type: "string",
          description: "Caminho relativo à raiz do codebase. Ex: app/Http/Controllers/RegulacaoController.php",
        },
        content: {
          type: "string",
          description: "Conteúdo completo do arquivo",
        },
      },
      required: ["codebase", "relative_path", "content"],
    },
  },
  {
    name: "patch_file",
    description: `Substitui um intervalo de linhas de um arquivo existente — ideal para correções cirúrgicas em arquivos grandes.
Fluxo recomendado:
  1. Use grep -n ou sed -n para localizar as linhas a alterar
  2. Leia o trecho com sed -n 'START,ENDp' para confirmar o contexto
  3. Aplique o patch com start_line/end_line exatos
O restante do arquivo é preservado integralmente.`,
    input_schema: {
      type: "object" as const,
      properties: {
        codebase: { type: "string" },
        relative_path: {
          type: "string",
          description: "Caminho relativo à raiz do codebase",
        },
        start_line: {
          type: "integer",
          description: "Primeira linha do trecho a substituir (1-indexed, inclusiva)",
        },
        end_line: {
          type: "integer",
          description: "Última linha do trecho a substituir (1-indexed, inclusiva)",
        },
        content: {
          type: "string",
          description: "Conteúdo que substituirá as linhas start_line..end_line (pode ter mais ou menos linhas que o original)",
        },
      },
      required: ["codebase", "relative_path", "start_line", "end_line", "content"],
    },
  },
  {
    name: "bash_exec",
    description: "Executa comandos git ou gh na raiz de um codebase. As credenciais de autor e de push são injetadas automaticamente. Permite '&&' apenas entre comandos git/gh.",
    input_schema: {
      type: "object" as const,
      properties: {
        codebase: { type: "string" },
        command: {
          type: "string",
          description: "Comando git ou gh. Ex: git checkout -b feat/PROJ-123",
        },
      },
      required: ["codebase", "command"],
    },
  },
  {
    name: "create_pull_request",
    description: "Cria uma Pull Request (GitHub/Bitbucket/Azure DevOps) ou Merge Request (GitLab) no provedor configurado em GIT_PROVIDER. Use após o git push.",
    input_schema: {
      type: "object" as const,
      properties: {
        codebase: { type: "string" },
        title: {
          type: "string",
          description: "Título no formato: type(ISSUE-KEY): resumo",
        },
        body: {
          type: "string",
          description: "Corpo em Markdown. Inclua: link do Jira, o que foi implementado, como testar.",
        },
        head_branch: {
          type: "string",
          description: "Branch de origem. Ex: feat/PROJ-123",
        },
        base_branch: {
          type: "string",
          description: "Branch de destino. Ex: master",
        },
      },
      required: ["codebase", "title", "body", "head_branch", "base_branch"],
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
    cache_control: { type: "ephemeral" } as any,
  },
];

// ─── Cache helpers ────────────────────────────────────────────────────────────

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

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(issueKey: string): string {
  return `Você é um engenheiro de software sênior. Implemente a demanda ${issueKey} do Jira seguindo rigorosamente a especificação técnica elaborada pelo analista.

## Passos obrigatórios

1. **Buscar e confiar na especificação técnica**: busque ${issueKey} no Jira e leia o campo \`technical_spec\` com atenção.
   - A spec já lista os arquivos, métodos e linhas a modificar — **vá diretamente a eles** com \`sed -n\`, sem re-explorar o que já está descrito.
   - Use list_codebases/list_modules apenas para arquivos **não mencionados** na spec.

2. **Explorar somente o que a spec não cobre**:
   - Use rg/grep -n para localizar linhas exatas dos trechos relevantes
   - **Disciplina de leitura — siga esta sequência por arquivo:**
     1. \`grep -n\` ou \`rg -n\` para localizar a linha exata
     2. \`sed -n 'INICIO,FIMp'\` para ler apenas o trecho necessário (±15 linhas do ponto de interesse)
     3. Nunca use \`cat\` em arquivos com mais de 100 linhas — a primeira leitura informa o tamanho total
     4. **Cada arquivo deve ser lido no máximo uma vez** — combine tudo em um único \`sed -n\` com range amplo se necessário
   - Máximo ${MAX_FILE_READS} leituras completas (cat/head/tail) — economize-as com \`sed -n\`

3. **Criar branch** de feature:
   O sistema sincroniza automaticamente a master com origin antes de criar a branch.
   Execute apenas:
   \`\`\`
   git checkout -b ${issueKey}
   \`\`\`

4. **Implementar** as mudanças conforme a especificação técnica:

   **Escolha da ferramenta de escrita — obrigatório:**
   - **Arquivos novos ou pequenos (≤ 150 linhas):** use write_file com o conteúdo completo
   - **Modificações em arquivos existentes:** use patch_file — **nunca releia o arquivo inteiro antes de patchear**
     - Fluxo obrigatório: \`grep -n\` → \`sed -n 'X,Yp'\` (apenas o trecho) → \`patch_file\` com start_line/end_line exatos
     - O patch substitui apenas as linhas indicadas; o resto do arquivo é preservado integralmente
     - Para múltiplas alterações no mesmo arquivo: aplique os patches da **última linha para a primeira** (evita deslocamento de índices)
   - **Nunca** use write_file para reescrever um arquivo grande — o limite de tokens de output impede a geração completa e o arquivo ficará truncado

   Siga os padrões já adotados no projeto (nomenclatura, namespaces, estrutura).
   Implemente apenas o que está descrito na especificação — sem funcionalidades extras.

5. **Commitar** as mudanças seguindo Conventional Commits:
   - Formato: \`type(${issueKey}): mensagem em português\`
   - Types: feat | fix | refactor | docs | chore | test
   - Execute em sequência com bash_exec:
     \`\`\`
     git add -A && git commit -m "type(${issueKey}): descrição concisa"
     \`\`\`

6. **Publicar** a branch:
   \`\`\`
   git push -u origin ${issueKey}
   \`\`\`
   As credenciais de push são injetadas automaticamente pelo sistema.

7. **Abrir PR/MR** usando a ferramenta create_pull_request:
   - title: "type(${issueKey}): resumo"
   - body (Markdown): link Jira + lista do que foi implementado + como testar
   - head_branch: ${issueKey}
   - base_branch: master (ou a branch padrão do projeto)
  - **Nunca** use \'gh pr create\' no bash_exec.

8. **Transitar** o status do issue para "${DONE_STATUS}".

## Tratamento de erros de acesso ao código

Se ao tentar acessar qualquer codebase (list_modules, bash_read, write_file, patch_file, bash_exec) ocorrer um erro de clone, autenticação ou acesso ao repositório:
1. **Poste imediatamente um comentário** no issue ${issueKey} via \`jira_add_comment\` com:
   - Descrição clara do erro recebido
   - Possíveis causas (credenciais inválidas/ausentes, URL errada, permissão negada, timeout, etc.)
   - Orientação para corrigir e re-enfileirar a demanda
2. Não tente prosseguir com a implementação sem o código — encerre após postar o comentário.

Seja fiel à especificação técnica. Siga os padrões de código existentes no projeto.`;
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

async function doImplementation(issueKey: string, rowId: number | null, options?: AgentRunOptions): Promise<void> {
  const codebases = resolveCodebases();

  async function resolveCodebaseOrError(codebaseName: string): Promise<CodebaseEntry> {
    const entry = codebases.find((c) => c.name === codebaseName);
    if (!entry) {
      throw new Error(`Codebase "${codebaseName}" não encontrado. Disponíveis: ${codebases.map((c) => c.name).join(", ")}`);
    }
    try {
      await ensureCodebaseCloned(entry);
    } catch (cloneErr) {
      const msg = String(cloneErr);
      const comment =
        `## ⚠️ Erro de acesso ao repositório\n\n` +
        `O agente implementador não conseguiu acessar o codebase **${codebaseName}** necessário para implementar esta demanda.\n\n` +
        `**Erro:**\n\`\`\`\n${msg}\n\`\`\`\n\n` +
        `**Possíveis causas:**\n` +
        `- Credenciais Git ausentes ou expiradas (verifique \`GIT_TOKEN\` / \`GIT_USER\`/\`GIT_PASSWORD\` nas variáveis de ambiente)\n` +
        `- URL do repositório incorreta ou inacessível (verifique \`repository_url\` em codebases.json)\n` +
        `- Repositório privado sem permissão de leitura/escrita para o token configurado\n` +
        `- Falha de rede ou timeout ao clonar (verifique conectividade e \`CODEBASE_CLONE_TIMEOUT_MS\`)\n` +
        `- Caminho local do codebase sem permissão de escrita (verifique \`CODEBASES_ROOT\`)\n\n` +
        `Corrija o problema e re-enfileire a demanda.`;
      try {
        await jiraAddComment(issueKey, comment);
        console.warn(`[implementor] ${issueKey}: comentário de erro de clone postado para "${codebaseName}"`);
      } catch (commentErr) {
        console.warn(`[implementor] aviso: não foi possível postar comentário de erro: ${commentErr}`);
      }
      throw cloneErr;
    }
    return entry;
  }

  // ── Transição inicial: sinaliza que o agente começou a trabalhar ──────────
  try {
    await jiraTransitionToStatus(issueKey, START_STATUS);
    console.log(`[implementor] ${issueKey}: status → "${START_STATUS}"`);
  } catch (err) {
    console.warn(`[implementor] aviso: não foi possível transitar para "${START_STATUS}": ${err}`);
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      // Ponto 2 de cache: prompt inicial fixo por issue
      content: [{ type: "text", text: buildPrompt(issueKey), cache_control: { type: "ephemeral" } as any }],
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

  try {
    while (turns < 40) {
      if (options?.checkpoint) {
        await options.checkpoint();
      }
      if (turns > 0 && lastHeaders) {
        await interTurnDelay("implementor", lastHeaders);
      }
      turns++;

      applyRollingCache(messages); // Ponto 3: marca último user-block para cache

      const { data: response, response: httpResponse } =
        await client.messages.create({
          model: MODEL,
          max_tokens: 8192,
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

      for (const block of response.content) {
        if (block.type === "text") process.stdout.write(block.text);
        else if (block.type === "tool_use")
          console.log(`\n  [tool: ${block.name}(${JSON.stringify(block.input).slice(0, 120)})]`);
      }

      if (response.stop_reason === "end_turn") {
        finalStatus = "success";
        break;
      }

      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const inp = block.input as Record<string, unknown>;
            let result: string;
            try {
              if (block.name === "jira_get_issue") {
                result = await jiraGetIssue(inp.issue_key as string);

              } else if (block.name === "list_codebases") {
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

              } else if (block.name === "list_modules") {
                const entry = await resolveCodebaseOrError(inp.codebase as string);
                if (!entry.modules?.length) {
                  result = `Codebase "${inp.codebase}" não possui módulos definidos. Explore com bash_read.`;
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

              } else if (block.name === "write_file") {
                await resolveCodebaseOrError(inp.codebase as string);
                result = execWriteFile(
                  inp.codebase as string,
                  inp.relative_path as string,
                  inp.content as string,
                  codebases
                );

              } else if (block.name === "patch_file") {
                await resolveCodebaseOrError(inp.codebase as string);
                result = execPatchFile(
                  inp.codebase as string,
                  inp.relative_path as string,
                  inp.start_line as number,
                  inp.end_line as number,
                  inp.content as string,
                  codebases
                );

              } else if (block.name === "bash_exec") {
                await resolveCodebaseOrError(inp.codebase as string);
                result = execBashExec(
                  inp.codebase as string,
                  inp.command as string,
                  codebases
                );

              } else if (block.name === "create_pull_request") {
                const entry = await resolveCodebaseOrError(inp.codebase as string);
                try {
                  result = await createPullRequest({
                    cwd: entry.path,
                    title: inp.title as string,
                    body: inp.body as string,
                    headBranch: inp.head_branch as string,
                    baseBranch: inp.base_branch as string,
                  });
                } catch (prErr) {
                  const errMsg = String(prErr);
                  const branch = String(inp.head_branch ?? issueKey);
                  const provider = (process.env.GIT_PROVIDER ?? "github").toLowerCase();
                  const providerHints =
                    provider === "github"
                      ? "- Token sem escopo suficiente no GitHub (Fine-grained: Pull requests Read/Write + Contents Read/Write; Classic: repo)\\n- Token sem acesso ao repositório alvo\\n- Repositório com política que bloqueia criação de PR por API"
                      : provider === "gitlab"
                        ? "- GITLAB_TOKEN sem escopo api\\n- Token sem permissão no projeto (Developer/Maintainer)"
                        : provider === "bitbucket"
                          ? "- BITBUCKET_APP_PASSWORD sem permissão Repositories:Read/Write\\n- App password vinculado a usuário sem acesso ao repositório"
                          : "- AZURE_DEVOPS_PAT sem escopo Code (Read & Write)\\n- PAT sem acesso ao projeto/repositório no Azure DevOps";

                  const comment =
                    `## ⚠️ Falha ao criar Pull Request\\n\\n` +
                    `O agente implementador concluiu as alterações e fez push da branch, mas não conseguiu abrir a PR/MR automaticamente.\\n\\n` +
                    `**Branch publicada:** \`${branch}\`\\n` +
                    `**Codebase:** \`${String(inp.codebase ?? "(não informado)")}\`\\n\\n` +
                    `**Erro retornado:**\\n\`\`\`\\n${errMsg}\\n\`\`\`\\n\\n` +
                    `**Possíveis causas (${provider}):**\\n${providerHints}\\n\\n` +
                    `**Ação recomendada:** ajustar permissões do token e reexecutar a automação, ou abrir a PR/MR manualmente para a branch \`${branch}\`.`;

                  try {
                    await jiraAddComment(issueKey, comment);
                    console.warn(`[implementor] ${issueKey}: comentário de falha de PR postado no Jira.`);
                  } catch (commentErr) {
                    console.warn(`[implementor] aviso: não foi possível postar comentário de falha de PR: ${commentErr}`);
                  }

                  result = `Erro: ${errMsg}`;
                }

              } else if (block.name === "jira_add_comment") {
                await jiraAddComment(inp.issue_key as string, inp.comment as string);
                result = "Comentário adicionado.";

              } else if (block.name === "jira_transition_issue") {
                result = await jiraTransitionToStatus(
                  inp.issue_key as string,
                  inp.status_name as string
                );

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
        console.log(`\n[implementor] stop_reason inesperado: ${response.stop_reason}`);
        break;
      }
    }
  } finally {
    console.log(
      `\n[implementor] ${issueKey} — status: ${finalStatus} | turnos: ${turns}` +
        ` | tokens in: ${inputTokens} out: ${outputTokens}` +
        ` cache_read: ${cacheReadTokens} cache_write: ${cacheCreationTokens}` +
        ` | file_reads: ${fileReadCount.n}/${MAX_FILE_READS} unique_files: ${fileAccessCount.size}`
    );

    // ── Transição de erro: sinaliza que o agente parou sem concluir ──────────
    if (finalStatus === "error") {
      try {
        await jiraTransitionToStatus(issueKey, ERROR_STATUS);
        console.log(`[implementor] ${issueKey}: erro → status "${ERROR_STATUS}"`);
      } catch (err) {
        console.warn(`[implementor] aviso: não foi possível transitar para "${ERROR_STATUS}": ${err}`);
      }
    }

    if (rowId !== null) {
      await dbFinishSession(rowId, finalStatus);
    }
  }
}

export async function implementIssue(issueKey: string, options?: AgentRunOptions): Promise<void> {
  console.log(`\n[implementor] iniciando implementação: ${issueKey}`);
  const rowId = await dbInsertSession("implementor", issueKey, MODEL);
  await withRateLimit(() => doImplementation(issueKey, rowId, options));
}
