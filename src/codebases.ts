import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseRemoteUrl } from "./git.js";

export interface ModuleEntry {
  name: string;
  description: string;
  keywords?: string[];
}

export interface CodebaseEntry {
  name: string;
  path: string;
  description: string;
  modules?: ModuleEntry[];
  repositoryUrl: string;
}

type CodebasesMode = "url";

function getRepoSlugFromUrl(repositoryUrl: string): string | null {
  const raw = repositoryUrl.trim();
  if (!raw) return null;

  // HTTPS/HTTP remotes
  try {
    const u = new URL(raw);
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    if (!last) return null;
    return last.endsWith(".git") ? last.slice(0, -4) : last;
  } catch {
    // continue for SSH-like formats
  }

  // SSH remotes: git@host:owner/repo.git or ssh://git@host/owner/repo.git
  const sshSimple = raw.match(/^git@[^:]+:(.+)$/);
  if (sshSimple) {
    const pathPart = sshSimple[1] ?? "";
    const pieces = pathPart.split("/");
    const last = pieces[pieces.length - 1] ?? "";
    if (!last) return null;
    return last.endsWith(".git") ? last.slice(0, -4) : last;
  }

  const sshScheme = raw.match(/^ssh:\/\/(?:[^@]+@)?[^/]+\/(.+)$/);
  if (sshScheme) {
    const pathPart = sshScheme[1] ?? "";
    const pieces = pathPart.split("/");
    const last = pieces[pieces.length - 1] ?? "";
    if (!last) return null;
    return last.endsWith(".git") ? last.slice(0, -4) : last;
  }

  return null;
}

function normalizeMode(raw: string | undefined): CodebasesMode {
  const mode = (raw ?? "url").toLowerCase().trim();
  if (mode !== "url") {
    console.warn(`[codebases] CODEBASES_MODE="${mode}" descontinuado; usando modo "url".`);
  }
  return "url";
}

interface RawCodebaseEntry {
  name?: string;
  path?: string;
  description?: string;
  modules?: ModuleEntry[];
  repositoryUrl?: string;
  repository_url?: string;
  repoUrl?: string;
  repo_url?: string;
  url?: string;
}

function normalizeStaticEntry(raw: RawCodebaseEntry, root: string): CodebaseEntry | null {
  if (!raw?.name || !raw?.description) return null;

  const repositoryUrl =
    raw.repositoryUrl ??
    raw.repository_url ??
    raw.repoUrl ??
    raw.repo_url ??
    raw.url;

  if (!repositoryUrl?.trim()) {
    console.warn(`[codebases] entrada "${raw.name}" ignorada: repository_url ausente.`);
    return null;
  }

  let host = "";
  try {
    host = parseRemoteUrl(repositoryUrl).host.toLowerCase();
  } catch {
    console.warn(`[codebases] entrada "${raw.name}" ignorada: repository_url invalida.`);
    return null;
  }

  const allowedHosts = (process.env.CODEBASES_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
    console.warn(`[codebases] entrada "${raw.name}" ignorada: host "${host}" fora da whitelist.`);
    return null;
  }

  let resolvedPath = raw.path?.trim();
  if (!resolvedPath && repositoryUrl) {
    const slug = getRepoSlugFromUrl(repositoryUrl);
    if (slug) {
      resolvedPath = path.resolve(root, slug);
    }
  }

  if (!resolvedPath) return null;

  return {
    name: raw.name,
    path: resolvedPath,
    description: raw.description,
    modules: raw.modules,
    repositoryUrl,
  };
}

function loadStaticCodebases(configPath: string, root: string): CodebaseEntry[] {
  try {
    if (!existsSync(configPath)) return [];
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { codebases?: RawCodebaseEntry[] };
    if (!Array.isArray(parsed.codebases)) return [];
    return parsed.codebases
      .map((c) => normalizeStaticEntry(c, root))
      .filter((c): c is CodebaseEntry => c !== null);
  } catch (err) {
    console.warn(`[codebases] falha ao ler config estatico: ${String(err)}`);
    return [];
  }
}

export function resolveCodebases(): CodebaseEntry[] {
  normalizeMode(process.env.CODEBASES_MODE);
  const configPath = process.env.CODEBASES_CONFIG ?? "/app/codebases.json";
  const root = process.env.CODEBASES_ROOT ?? process.env.CODEBASE_PATH ?? "/workspace/codebases";

  const staticEntries = loadStaticCodebases(configPath, root);
  const codebases = staticEntries;

  console.log(
    `[codebases] mode=url total=${codebases.length} root=${path.resolve(root)}`
  );
  return codebases;
}
