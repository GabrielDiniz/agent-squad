import { describe, expect, it } from "vitest";
import { adfToText, markdownToAdf } from "../jira.js";

describe("jira adf conversion", () => {
  it("converte heading e paragrafo", () => {
    const doc = markdownToAdf("# Titulo\n\nTexto simples");
    const content = (doc as any).content;

    expect(content[0].type).toBe("heading");
    expect(content[0].attrs.level).toBe(1);
    expect(content[1].type).toBe("paragraph");
  });

  it("converte formatacao inline", () => {
    const doc = markdownToAdf("**bold** *it* `code` [site](https://example.com)");
    const paragraph = (doc as any).content[0];
    const marks = paragraph.content.flatMap((n: any) => n.marks ?? []);

    expect(marks.some((m: any) => m.type === "strong")).toBe(true);
    expect(marks.some((m: any) => m.type === "em")).toBe(true);
    expect(marks.some((m: any) => m.type === "code")).toBe(true);
    expect(marks.some((m: any) => m.type === "link")).toBe(true);
  });

  it("converte listas e blockquote", () => {
    const md = "- um\n- dois\n\n1. a\n2. b\n\n> nota";
    const doc = markdownToAdf(md);
    const types = (doc as any).content.map((n: any) => n.type);

    expect(types).toContain("bulletList");
    expect(types).toContain("orderedList");
    expect(types).toContain("blockquote");
  });

  it("converte code fence", () => {
    const doc = markdownToAdf("```ts\nconst x = 1\n```");
    const node = (doc as any).content[0];

    expect(node.type).toBe("codeBlock");
    expect(node.attrs.language).toBe("ts");
    expect(node.content[0].text).toContain("const x = 1");
  });

  it("converte tabela markdown", () => {
    const md = "| Col1 | Col2 |\n|---|---|\n| A | B |";
    const doc = markdownToAdf(md);
    const table = (doc as any).content[0];

    expect(table.type).toBe("table");
    expect(table.content.length).toBe(2);
    expect(table.content[0].content[0].type).toBe("tableHeader");
  });

  it("retorna documento vazio quando markdown vazio", () => {
    const doc = markdownToAdf("");
    const content = (doc as any).content;

    expect(content.length).toBe(1);
    expect(content[0].type).toBe("paragraph");
  });

  it("adfToText extrai texto de paragrafos", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "linha 1" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "linha 2" }],
        },
      ],
    };

    expect(adfToText(adf)).toContain("linha 1");
    expect(adfToText(adf)).toContain("linha 2");
  });
});
