import { execSync } from "node:child_process";

export type GitProvider = "github" | "gitlab" | "bitbucket";

export function getProvider(): GitProvider {
  const raw = (process.env.GIT_PROVIDER ?? "github").toLowerCase().trim();
  if (raw === "github" || raw === "gitlab" || raw === "bitbucket") return raw;
  throw new Error(`GIT_PROVIDER inválido: "${raw}". Use: github | gitlab | bitbucket`);
}

// ─── Remote URL parsing ───────────────────────────────────────────────────────

export interface RemoteInfo {
  host: string;   // ex: github.com, gitlab.company.com
  owner: string;  // owner / namespace / workspace / project key
  repo: string;   // repository slug
  isSsh: boolean;
}

export function parseRemoteUrl(url: string): RemoteInfo {
  // Standard SSH: git@github.com:owner/repo.git
  const sshSimple = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshSimple) {
    const parts = (sshSimple[2] ?? "").split("/");
    const repo = parts.pop() ?? "";
    return { host: sshSimple[1] ?? "", owner: parts.join("/"), repo, isSsh: true };
  }

  // SSH with scheme: ssh://git@host[:port]/path/repo.git  (Bitbucket Server)
  const sshScheme = url.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/);
  if (sshScheme) {
    const parts = (sshScheme[2] ?? "").replace(/^scm\//, "").split("/");
    const repo = parts.pop() ?? "";
    return { host: sshScheme[1] ?? "", owner: parts.join("/"), repo, isSsh: true };
  }

  // HTTPS
  const parsed = new URL(url.endsWith(".git") ? url.slice(0, -4) : url);
  let pathname = parsed.pathname.replace(/^\//, "");

  // Bitbucket Server mounts repos under /scm/PROJECT/repo
  if (pathname.toLowerCase().startsWith("scm/")) pathname = pathname.slice(4);

  const parts = pathname.split("/");
  const repo = parts.pop() ?? "";
  return { host: parsed.host, owner: parts.join("/"), repo, isSsh: false };
}

// ─── Auth URL building ────────────────────────────────────────────────────────

/**
 * Returns an authenticated HTTPS remote URL for push/fetch operations.
 * For SSH remotes, converts to HTTPS and injects credentials so the container
 * does not need a configured SSH key or known_hosts entry.
 * Returns null if required credentials are absent from the environment.
 */
export function buildAuthenticatedUrl(remoteUrl: string): string | null {
  let info: RemoteInfo;
  try {
    info = parseRemoteUrl(remoteUrl);
  } catch {
    return null;
  }

  // SSH remotes use key-based auth — no URL rewriting needed.
  if (info.isSsh) return null;

  const httpsBase = remoteUrl.endsWith(".git") ? remoteUrl : remoteUrl + ".git";

  try {
    const u = new URL(httpsBase);
    u.username = "";
    u.password = "";

    switch (getProvider()) {
      case "github": {
        const token = process.env.GH_TOKEN ?? "";
        if (!token) return null;
        u.username = token;
        u.password = "x-oauth-basic";
        break;
      }
      case "gitlab": {
        const token = process.env.GITLAB_TOKEN ?? "";
        if (!token) return null;
        u.username = "oauth2";
        u.password = token;
        break;
      }
      case "bitbucket": {
        // Para git HTTPS no Bitbucket Cloud é necessário um App Password
        // (criado em bitbucket.org → Configurações → App passwords).
        // JIRA_API_TOKEN é um Atlassian API Token — funciona para a REST API
        // mas NÃO para operações git HTTPS no Bitbucket Cloud.
        const appPassword = process.env.BITBUCKET_APP_PASSWORD ?? "";
        const apiToken    = process.env.JIRA_API_TOKEN ?? "";
        const password    = appPassword || apiToken;
        if (!password) return null;
        u.username = "x-token-auth";
        u.password = password;
        break;
      }
    }

    // Preserve original .git suffix convention
    const result = u.toString();
    return remoteUrl.endsWith(".git") ? result : result.slice(0, -4);
  } catch {
    return null;
  }
}

// ─── Remote URL helper ────────────────────────────────────────────────────────

export function getRemoteUrl(cwd: string): string {
  return execSync("git remote get-url origin", {
    cwd,
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();
}

// ─── Pull Request / Merge Request creation ────────────────────────────────────

export interface CreatePRParams {
  cwd: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

export async function createPullRequest(params: CreatePRParams): Promise<string> {
  const remoteUrl = getRemoteUrl(params.cwd);
  const info = parseRemoteUrl(remoteUrl);

  switch (getProvider()) {
    case "github":    return createGithubPR(params, info);
    case "gitlab":    return createGitlabMR(params, info);
    case "bitbucket": return createBitbucketPR(params, info, remoteUrl);
  }
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

async function createGithubPR(params: CreatePRParams, info: RemoteInfo): Promise<string> {
  const token = process.env.GH_TOKEN ?? "";
  if (!token) throw new Error("GH_TOKEN não configurado.");

  // Support GitHub Enterprise Server via GITHUB_API_URL
  const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");

  const res = await fetch(`${apiBase}/repos/${info.owner}/${info.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: params.title,
      body: params.body,
      head: params.headBranch,
      base: params.baseBranch,
    }),
  });

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { html_url: string };
  return `Pull Request criada: ${data.html_url}`;
}

// ─── GitLab ──────────────────────────────────────────────────────────────────

async function createGitlabMR(params: CreatePRParams, info: RemoteInfo): Promise<string> {
  const token = process.env.GITLAB_TOKEN ?? "";
  if (!token) throw new Error("GITLAB_TOKEN não configurado.");

  // Supports GitLab.com and self-hosted instances via GITLAB_URL
  const gitlabBase = (process.env.GITLAB_URL ?? "https://gitlab.com").replace(/\/$/, "");
  const projectPath = encodeURIComponent(`${info.owner}/${info.repo}`);

  const res = await fetch(`${gitlabBase}/api/v4/projects/${projectPath}/merge_requests`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: params.title,
      description: params.body,
      source_branch: params.headBranch,
      target_branch: params.baseBranch,
      remove_source_branch: true,
    }),
  });

  if (!res.ok) throw new Error(`GitLab API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { web_url: string };
  return `Merge Request criada: ${data.web_url}`;
}

// ─── Bitbucket ───────────────────────────────────────────────────────────────

async function createBitbucketPR(
  params: CreatePRParams,
  info: RemoteInfo,
  _remoteUrl: string
): Promise<string> {
  // Reutiliza o mesmo token Atlassian do Jira — nenhuma config extra necessária
  const token = process.env.JIRA_API_TOKEN ?? "";
  if (!token) throw new Error("JIRA_API_TOKEN não configurado.");
  const authHeader = `Bearer ${token}`;

  // Default = Bitbucket Cloud; set BITBUCKET_URL for Server/Data Center
  const bbApiBase = (process.env.BITBUCKET_URL ?? "https://api.bitbucket.org").replace(/\/$/, "");
  const isCloud = bbApiBase.includes("api.bitbucket.org");

  let url: string;
  let body: unknown;

  if (isCloud) {
    // Bitbucket Cloud REST API 2.0
    url = `${bbApiBase}/2.0/repositories/${info.owner}/${info.repo}/pullrequests`;
    body = {
      title: params.title,
      description: params.body,
      source: { branch: { name: params.headBranch } },
      destination: { branch: { name: params.baseBranch } },
      close_source_branch: false,
    };
  } else {
    // Bitbucket Server / Data Center REST API 1.0
    // URL path: /scm/PROJECT_KEY/repo — owner may contain project key after scm/ strip
    const projectKey = info.owner.split("/").pop() ?? info.owner;
    url = `${bbApiBase}/rest/api/1.0/projects/${projectKey}/repos/${info.repo}/pull-requests`;
    body = {
      title: params.title,
      description: params.body,
      fromRef: { id: `refs/heads/${params.headBranch}` },
      toRef:   { id: `refs/heads/${params.baseBranch}` },
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader, // já contém o prefixo correto (Bearer ou Basic)
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Bitbucket API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;

  // Cloud returns links.html.href; Server returns links.self[0].href
  const prUrl =
    (data as any).links?.html?.href ??
    (data as any).links?.self?.[0]?.href ??
    "(URL não disponível)";
  return `Pull Request criada: ${prUrl}`;
}
