const BASE = process.env.JIRA_URL!;
const AUTH = Buffer.from(
  `${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

async function req(path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}/rest/api/3${path}`, {
    method,
    headers: {
      Authorization: `Basic ${AUTH}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Jira ${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── ADF read ────────────────────────────────────────────────────────────────

// Extrai texto plano de Atlassian Document Format (ADF)
function adfToText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (Array.isArray(node.content)) {
    return node.content.map(adfToText).join(node.type === "paragraph" ? "\n" : "");
  }
  return "";
}

// ─── Markdown → ADF write ────────────────────────────────────────────────────

type AdfMark = { type: string; attrs?: Record<string, unknown> };
type AdfTextNode = { type: "text"; text: string; marks?: AdfMark[] };
type AdfNode = Record<string, unknown>;

/**
 * Converte um trecho de texto com marcação inline (negrito, itálico, code,
 * links) em uma lista de nós ADF do tipo "text".
 *
 * Ordem de precedência: ** antes de * para evitar captura parcial.
 */
function parseInline(text: string): AdfTextNode[] {
  const nodes: AdfTextNode[] = [];
  // Padrão: **bold** | __bold__ | *italic* | _italic_ | `code` | [label](url)
  const re = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/gs;
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) {
      nodes.push({ type: "text", text: text.slice(cursor, m.index) });
    }

    if (m[1]) {
      // **bold** ou __bold__
      nodes.push({ type: "text", text: m[2] ?? "", marks: [{ type: "strong" }] });
    } else if (m[3]) {
      // *italic* ou _italic_
      nodes.push({ type: "text", text: m[4] ?? "", marks: [{ type: "em" }] });
    } else if (m[5] !== undefined) {
      // `code`
      nodes.push({ type: "text", text: m[5], marks: [{ type: "code" }] });
    } else if (m[6]) {
      // [label](url)
      nodes.push({
        type: "text",
        text: m[6],
        marks: [{ type: "link", attrs: { href: m[7] ?? "" } }],
      });
    }

    cursor = m.index + m[0].length;
  }

  if (cursor < text.length) {
    nodes.push({ type: "text", text: text.slice(cursor) });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", text }];
}

function makeParagraph(text: string): AdfNode {
  return { type: "paragraph", content: parseInline(text) };
}

/**
 * Converte Markdown em Atlassian Document Format (ADF).
 *
 * Suporte:
 *   # Heading 1–6          → heading node
 *   **bold** / *italic*    → strong / em marks
 *   `inline code`          → code mark
 *   [label](url)           → link mark
 *   ```lang … ```          → codeBlock node
 *   - item / * item        → bulletList
 *   1. item                → orderedList
 *   --- / *** / ___        → rule node
 *   > blockquote           → blockquote node
 *   Linhas normais         → paragraph
 */
function markdownToAdf(markdown: string): AdfNode {
  const lines = markdown.split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // ── Code fence ────────────────────────────────────────────────────────
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plain";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // pula o fechamento ```
      content.push({
        type: "codeBlock",
        attrs: { language: lang },
        content: [{ type: "text", text: codeLines.join("\n") }],
      });
      continue;
    }

    // ── Heading ───────────────────────────────────────────────────────────
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      content.push({
        type: "heading",
        attrs: { level: (hm[1] ?? "").length },
        content: parseInline(hm[2] ?? ""),
      });
      i++;
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────
    if (/^([-*_])\1{2,}$/.test(line.trim())) {
      content.push({ type: "rule" });
      i++;
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────
    if (line.startsWith("> ")) {
      const qLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("> ")) {
        qLines.push((lines[i] ?? "").slice(2));
        i++;
      }
      content.push({
        type: "blockquote",
        content: [makeParagraph(qLines.join(" "))],
      });
      continue;
    }

    // ── Bullet list ───────────────────────────────────────────────────────
    if (/^[-*+]\s+/.test(line)) {
      const items: AdfNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i] ?? "")) {
        const text = (lines[i] ?? "").replace(/^[-*+]\s+/, "");
        items.push({
          type: "listItem",
          content: [makeParagraph(text)],
        });
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    // ── Ordered list ──────────────────────────────────────────────────────
    if (/^\d+\.\s+/.test(line)) {
      const items: AdfNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
        const text = (lines[i] ?? "").replace(/^\d+\.\s+/, "");
        items.push({
          type: "listItem",
          content: [makeParagraph(text)],
        });
        i++;
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }

    // ── Table ─────────────────────────────────────────────────────────────
    if (line.startsWith("|")) {
      // Coleta todas as linhas contíguas que começam com |
      const tableLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) {
        tableLines.push(lines[i] ?? "");
        i++;
      }

      // Divide uma linha de tabela nas células, removendo as pipes externas
      const parseRow = (row: string): string[] =>
        row.split("|").slice(1, -1).map((c) => c.trim());

      // Linha separadora: |---|:---|:---:|  etc.
      const isSeparator = (row: string): boolean =>
        /^\|[\s|:=-]+\|$/.test(row.trim());

      let headerCells: string[] | null = null;
      const dataRows: string[][] = [];

      for (const tLine of tableLines) {
        if (isSeparator(tLine)) continue;
        if (headerCells === null) {
          headerCells = parseRow(tLine);
        } else {
          dataRows.push(parseRow(tLine));
        }
      }

      if (headerCells && headerCells.length > 0) {
        const tableRows: AdfNode[] = [];

        // Linha de cabeçalho
        tableRows.push({
          type: "tableRow",
          content: headerCells.map((cell) => ({
            type: "tableHeader",
            attrs: {},
            content: [{ type: "paragraph", content: parseInline(cell) }],
          })),
        });

        // Linhas de dados
        for (const dataRow of dataRows) {
          tableRows.push({
            type: "tableRow",
            content: dataRow.map((cell) => ({
              type: "tableCell",
              attrs: {},
              content: [{ type: "paragraph", content: parseInline(cell) }],
            })),
          });
        }

        content.push({
          type: "table",
          attrs: { isNumberColumnEnabled: false, layout: "default" },
          content: tableRows,
        });
      }
      continue;
    }

    // ── Empty line ────────────────────────────────────────────────────────
    if (line.trim() === "") {
      i++;
      continue;
    }

    // ── Paragraph (agrupa linhas consecutivas) ────────────────────────────
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").startsWith("#") &&
      !(lines[i] ?? "").startsWith("```") &&
      !(lines[i] ?? "").startsWith("> ") &&
      !(lines[i] ?? "").startsWith("|") &&
      !/^[-*+]\s+/.test(lines[i] ?? "") &&
      !/^\d+\.\s+/.test(lines[i] ?? "") &&
      !/^([-*_])\1{2,}$/.test((lines[i] ?? "").trim())
    ) {
      paraLines.push(lines[i] ?? "");
      i++;
    }

    if (paraLines.length > 0) {
      content.push(makeParagraph(paraLines.join(" ")));
    }
  }

  return {
    version: 1,
    type: "doc",
    content: content.length > 0
      ? content
      : [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export async function jiraGetIssue(issueKey: string): Promise<string> {
  const analystFieldId = process.env.JIRA_ANALYST_FIELD_ID ?? "";
  const extraFields = analystFieldId ? `,${analystFieldId}` : "";
  const fields = `summary,description,status,issuetype,priority,labels,customfield_10016${extraFields}`;
  const data = await req(`/issue/${issueKey}?fields=${fields}`);

  const result: Record<string, unknown> = {
    key: data.key,
    type: data.fields.issuetype?.name,
    status: data.fields.status?.name,
    priority: data.fields.priority?.name,
    summary: data.fields.summary,
    description: adfToText(data.fields.description),
    acceptance_criteria: adfToText(data.fields.customfield_10016),
    labels: data.fields.labels,
  };

  if (analystFieldId) {
    const raw = data.fields[analystFieldId];
    result.technical_spec = raw
      ? (typeof raw === "string" ? raw : adfToText(raw))
      : null;
  }

  return JSON.stringify(result);
}

export async function jiraUpdateIssueField(
  issueKey: string,
  fieldId: string,
  markdown: string
): Promise<void> {
  await req(`/issue/${issueKey}`, "PUT", {
    fields: { [fieldId]: markdownToAdf(markdown) },
  });
}

export async function jiraAddComment(issueKey: string, markdown: string): Promise<void> {
  await req(`/issue/${issueKey}/comment`, "POST", {
    body: markdownToAdf(markdown),
  });
}

export async function jiraTransitionToStatus(
  issueKey: string,
  statusName: string
): Promise<string> {
  const { transitions } = await req(`/issue/${issueKey}/transitions`);
  const list = transitions as any[];

  // Exact match (case-insensitive)
  let match = list.find((t) => t.to.name.toLowerCase() === statusName.toLowerCase());

  // Fallback: partial match (target name contains requested name or vice-versa)
  if (!match) {
    const needle = statusName.toLowerCase();
    match = list.find(
      (t) =>
        t.to.name.toLowerCase().includes(needle) ||
        needle.includes(t.to.name.toLowerCase())
    );
  }

  if (!match) {
    const available = list.map((t) => t.to.name).join(", ");
    // Return a warning string instead of throwing so agents don't burn turns retrying
    return `⚠ Status "${statusName}" não encontrado — sem alteração. Disponíveis: ${available}`;
  }

  await req(`/issue/${issueKey}/transitions`, "POST", { transition: { id: match.id } });

  const wasExact = match.to.name.toLowerCase() === statusName.toLowerCase();
  return wasExact
    ? `Status alterado para "${match.to.name}".`
    : `Status alterado para "${match.to.name}" (fallback de "${statusName}").`;
}
