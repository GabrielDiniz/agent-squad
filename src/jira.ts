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

// Extrai texto plano de Atlassian Document Format (ADF)
function adfToText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (Array.isArray(node.content)) {
    return node.content.map(adfToText).join(node.type === "paragraph" ? "\n" : "");
  }
  return "";
}

export async function jiraGetIssue(issueKey: string): Promise<string> {
  const fields = "summary,description,status,issuetype,priority,labels,customfield_10016";
  const data = await req(`/issue/${issueKey}?fields=${fields}`);
  return JSON.stringify({
    key: data.key,
    type: data.fields.issuetype?.name,
    status: data.fields.status?.name,
    priority: data.fields.priority?.name,
    summary: data.fields.summary,
    description: adfToText(data.fields.description),
    acceptance_criteria: adfToText(data.fields.customfield_10016),
    labels: data.fields.labels,
  });
}

export async function jiraAddComment(issueKey: string, text: string): Promise<void> {
  const paragraphs = text.split(/\n{2,}/).filter(Boolean).map((p) => ({
    type: "paragraph",
    content: [{ type: "text", text: p }],
  }));
  await req(`/issue/${issueKey}/comment`, "POST", {
    body: { version: 1, type: "doc", content: paragraphs },
  });
}

export async function jiraTransitionToStatus(
  issueKey: string,
  statusName: string
): Promise<string> {
  const { transitions } = await req(`/issue/${issueKey}/transitions`);
  const match = (transitions as any[]).find(
    (t) => t.to.name.toLowerCase() === statusName.toLowerCase()
  );
  if (!match) {
    const available = (transitions as any[]).map((t) => t.to.name).join(", ");
    throw new Error(`Status "${statusName}" não encontrado. Disponíveis: ${available}`);
  }
  await req(`/issue/${issueKey}/transitions`, "POST", { transition: { id: match.id } });
  return `Status alterado para "${match.to.name}".`;
}
