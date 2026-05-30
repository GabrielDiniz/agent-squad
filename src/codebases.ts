import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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
  repositoryUrl?: string;
}

type CodebasesMode = "static" | "discover" | "hybrid";

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
  const mode = (raw ?? "hybrid").toLowerCase().trim();
  if (mode === "static" || mode === "discover" || mode === "hybrid") {
    return mode;
  }
  return "hybrid";
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

function discoverLocalCodebases(root: string): CodebaseEntry[] {
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const result: CodebaseEntry[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch (err) {
    console.warn(`[codebases] falha ao listar raiz ${root}: ${String(err)}`);
    return [];
  }

  for (const entryName of entries) {
    const fullPath = path.resolve(root, entryName);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
      if (!existsSync(path.join(fullPath, ".git"))) continue;

      result.push({
        name: entryName,
        path: fullPath,
        description: `Codebase descoberto automaticamente em ${fullPath}`,
        repositoryUrl: undefined,
      });
    } catch {
      // ignore entry-level errors
    }
  }

  return result;
}

function mergeHybrid(staticEntries: CodebaseEntry[], discoveredEntries: CodebaseEntry[]): CodebaseEntry[] {
  const byKey = new Map<string, CodebaseEntry>();

  const add = (entry: CodebaseEntry) => {
    const resolved = path.resolve(entry.path);
    const key = `${entry.name.toLowerCase()}::${resolved}`;
    if (!byKey.has(key)) {
      byKey.set(key, { ...entry, path: resolved });
      return;
    }

    const prev = byKey.get(key)!;
    byKey.set(key, {
      ...entry,
      path: resolved,
      modules: prev.modules?.length ? prev.modules : entry.modules,
      description: prev.description || entry.description,
    });
  };

  for (const entry of staticEntries) add(entry);
  for (const entry of discoveredEntries) add(entry);

  return [...byKey.values()];
}

export function resolveCodebases(): CodebaseEntry[] {
  const mode = normalizeMode(process.env.CODEBASES_MODE);
  const configPath = process.env.CODEBASES_CONFIG ?? "/app/codebases.json";
  const root = process.env.CODEBASES_ROOT ?? process.env.CODEBASE_PATH ?? "/workspace";

  const staticEntries = loadStaticCodebases(configPath, root);
  const discoveredEntries = discoverLocalCodebases(root);

  let codebases: CodebaseEntry[];
  if (mode === "static") {
    codebases = staticEntries;
  } else if (mode === "discover") {
    codebases = discoveredEntries;
  } else {
    codebases = mergeHybrid(staticEntries, discoveredEntries);
  }

  if (codebases.length === 0) {
    codebases = [
      {
        name: "default",
        path: path.resolve(root),
        description: "Codebase principal (fallback)",
      },
    ];
  }

  console.log(
    `[codebases] mode=${mode} static=${staticEntries.length} discovered=${discoveredEntries.length} total=${codebases.length}`
  );
  return codebases;
}
