/**
 * SSH key setup from environment variable.
 *
 * Lê GIT_SSH_KEY_B64 (chave privada SSH em base64), escreve num arquivo
 * temporário com permissão 0600 e configura GIT_SSH_COMMAND para que TODOS
 * os processos git filhos (clone, fetch, push) usem essa chave automaticamente.
 *
 * Por que base64 na env?
 *   - Funciona em qualquer ambiente: Docker, CI/CD, Kubernetes secrets, etc.
 *   - Não requer volume mount de ~/.ssh nem permissões especiais no host.
 *   - O arquivo temporário é destruído com o container — nunca persiste em disco.
 *
 * Geração da chave (fazer uma vez por projeto):
 *   ssh-keygen -t ed25519 -C "agent-squad deploy key" -f agent_deploy_key -N ""
 *   cat agent_deploy_key | base64 -w 0   → valor de GIT_SSH_KEY_B64
 *   cat agent_deploy_key.pub             → adicionar como deploy key nos repos
 *
 * Deploy keys:
 *   GitHub  → Settings → Deploy keys → Add deploy key (Read-only para clone)
 *   GitLab  → Settings → Repository → Deploy keys
 *   Bitbucket → Repository settings → Access keys
 */

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

let tmpKeyPath: string | null = null;

/**
 * Configura a chave SSH a partir de GIT_SSH_KEY_B64.
 * Deve ser chamada uma única vez, antes de qualquer operação git.
 * No-op se a variável não estiver definida.
 */
export function setupSshKey(): void {
  const b64 = process.env.GIT_SSH_KEY_B64;
  if (!b64) return;

  // Já configurado (ex: reinicialização em hot-reload)
  if (process.env.GIT_SSH_COMMAND) return;

  let keyContent: string;
  try {
    keyContent = Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    console.error("[ssh-setup] GIT_SSH_KEY_B64 não é base64 válido — ignorado.");
    return;
  }

  // Garante newline no final (git/SSH rejeitam chaves sem ele)
  if (!keyContent.endsWith("\n")) keyContent += "\n";

  // Valida estrutura mínima da chave PEM/OpenSSH
  if (!keyContent.includes("PRIVATE KEY")) {
    console.error("[ssh-setup] GIT_SSH_KEY_B64 não parece conter uma chave privada válida.");
    return;
  }

  // Cria arquivo temporário com nome aleatório para evitar colisões
  const suffix = randomBytes(6).toString("hex");
  tmpKeyPath = join(tmpdir(), `agent_ssh_key_${suffix}`);

  try {
    writeFileSync(tmpKeyPath, keyContent, { mode: 0o600, encoding: "utf-8" });
  } catch (err) {
    console.error(`[ssh-setup] Não foi possível escrever a chave em ${tmpKeyPath}: ${err}`);
    tmpKeyPath = null;
    return;
  }

  // Injeta GIT_SSH_COMMAND no processo atual — herdado por todos os filhos
  // -i: usa nossa chave; -o StrictHostKeyChecking=no: aceita novos hosts automaticamente
  // (known_hosts do sistema já popula os hosts principais no Dockerfile)
  process.env.GIT_SSH_COMMAND = `ssh -i ${tmpKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;

  console.log(`[ssh-setup] Chave SSH carregada de GIT_SSH_KEY_B64 → ${tmpKeyPath}`);
}

/**
 * Remove o arquivo temporário da chave. Chamado automaticamente no exit.
 */
export function cleanupSshKey(): void {
  if (tmpKeyPath && existsSync(tmpKeyPath)) {
    try {
      unlinkSync(tmpKeyPath);
    } catch {
      // ignora — o container vai morrer de qualquer forma
    }
    tmpKeyPath = null;
  }
}
