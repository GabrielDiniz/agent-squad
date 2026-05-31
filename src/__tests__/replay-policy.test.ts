import { describe, expect, it } from "vitest";
import { getReplayCacheKey } from "../agents/replay-policy.js";

describe("replay policy", () => {
  it("permite replay apenas para tools read-only whitelisted", () => {
    expect(getReplayCacheKey("reviewer", "jira_get_issue", { issue_key: "VAT-10" })).toBe("jira_get_issue:VAT-10");
    expect(getReplayCacheKey("analyst", "list_codebases", {})).toBe("list_codebases");
    expect(getReplayCacheKey("implementor", "list_modules", { codebase: "app-main" })).toBe("list_modules:app-main");
    expect(getReplayCacheKey("implementor", "bash_read", { codebase: "app-main", command: "cat README.md" })).toBe(
      "bash_read:app-main:cat README.md"
    );
  });

  it("bloqueia replay para tools mutáveis com efeito colateral", () => {
    expect(getReplayCacheKey("reviewer", "jira_transition_issue", { issue_key: "VAT-10", status_name: "Aprovado" })).toBeNull();
    expect(getReplayCacheKey("analyst", "jira_update_field", { issue_key: "VAT-11" })).toBeNull();
    expect(getReplayCacheKey("implementor", "write_file", { codebase: "app-main", relative_path: "a.ts" })).toBeNull();
    expect(getReplayCacheKey("implementor", "patch_file", { codebase: "app-main", relative_path: "a.ts" })).toBeNull();
    expect(getReplayCacheKey("implementor", "bash_exec", { codebase: "app-main", command: "npm test" })).toBeNull();
    expect(getReplayCacheKey("implementor", "create_pull_request", { codebase: "app-main" })).toBeNull();
  });

  it("gera chave determinística e consistente para o mesmo input", () => {
    const keyA = getReplayCacheKey("analyst", "bash_read", { codebase: "app-main", command: "rg -n queue src" });
    const keyB = getReplayCacheKey("analyst", "bash_read", { codebase: "app-main", command: "rg -n queue src" });
    expect(keyA).toBe(keyB);
  });
});
