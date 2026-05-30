import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildAuthenticatedUrl, parseRemoteUrl } from "./git.js";
import type { CodebaseEntry } from "./codebases.js";

const cloneLocks = new Map<string, Promise<void>>();

function sanitizeUrlForLogs(url: string): string {
  try {
    const u = new URL(url);
    u.username = u.username ? "***" : "";
    u.password = u.password ? "***" : "";
    return u.toString();
  } catch {
    return url.replace(/([^@]{2})[^@]*@/, "$1***@");
  }
}

function ensureParentDir(targetPath: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
}

function cloneRepo(entry: CodebaseEntry): void {
  const repoUrl = entry.repositoryUrl;
  const authUrl = buildAuthenticatedUrl(repoUrl) ?? repoUrl;
  const safeUrl = sanitizeUrlForLogs(repoUrl);

  ensureParentDir(entry.path);
  const startedAt = Date.now();
  console.log(`[repo] clone start name=${entry.name} url=${safeUrl} path=${entry.path}`);

  const proc = spawnSync("git", ["clone", authUrl, entry.path], {
    stdio: "pipe",
    timeout: Number(process.env.CODEBASE_CLONE_TIMEOUT_MS ?? 300_000),
    maxBuffer: 1024 * 512,
    encoding: "utf-8",
  });
  if (proc.status !== 0) {
    const stderr = (proc.stderr ?? "").toString();
    const stdout = (proc.stdout ?? "").toString();
    const combined = `${stdout}\n${stderr}`.trim();
    const safeCombined = combined
      .replaceAll(authUrl, sanitizeUrlForLogs(repoUrl))
      .replaceAll(repoUrl, sanitizeUrlForLogs(repoUrl));
    throw new Error(`git clone falhou: ${safeCombined || "erro desconhecido"}`);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[repo] clone done name=${entry.name} elapsed_ms=${elapsedMs}`);
}

async function withRetries(fn: () => void, retries: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      fn();
      return;
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      const waitMs = 1000 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

export async function ensureCodebaseCloned(entry: CodebaseEntry): Promise<void> {
  if (existsSync(path.join(entry.path, ".git"))) return;

  const key = `${entry.name.toLowerCase()}::${entry.path}`;
  const active = cloneLocks.get(key);
  if (active) {
    await active;
    return;
  }

  const work = (async () => {
    if (existsSync(path.join(entry.path, ".git"))) return;

    const host = parseRemoteUrl(entry.repositoryUrl).host.toLowerCase();
    const allowedHosts = (process.env.CODEBASES_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
      throw new Error(`Host "${host}" não permitido para clone automático.`);
    }

    const retries = Number(process.env.CODEBASE_CLONE_RETRIES ?? 1);
    await withRetries(() => cloneRepo(entry), retries);
  })();

  cloneLocks.set(key, work);
  try {
    await work;
  } finally {
    cloneLocks.delete(key);
  }
}
