import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintMemoryWikiVault } from "./lint.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("lintMemoryWikiVault", () => {
  it("detects duplicate ids, provenance gaps, contradictions, and open questions", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["entities", "concepts", "sources", "syntheses"].map((dir) =>
        fs.mkdir(path.join(rootDir, dir), { recursive: true }),
      ),
    );

    const duplicate = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        contradictions: ["Conflicts with source.beta"],
        questions: ["Is Alpha still active?"],
        confidence: 0.2,
        claims: [
          {
            id: "claim.alpha.db",
            text: "Alpha uses PostgreSQL for production writes.",
            confidence: 0.2,
            evidence: [],
          },
        ],
      },
      body: "# Alpha\n\n[[missing-page]]\n",
    });
    await fs.writeFile(path.join(rootDir, "entities", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(path.join(rootDir, "concepts", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.alpha",
          title: "Bridge Alpha",
          sourceType: "memory-bridge",
        },
        body: "# Bridge Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "alpha-db.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.alpha.db",
          title: "Alpha Database",
          sourceIds: ["source.bridge.alpha"],
          updatedAt: "2025-10-01T00:00:00.000Z",
          claims: [
            {
              id: "claim.alpha.db",
              text: "Alpha uses MySQL for production writes.",
              status: "contested",
              confidence: 0.7,
              evidence: [
                {
                  sourceId: "source.bridge.alpha",
                  lines: "1-3",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        body: "# Alpha Database\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issueCount).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate-id");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-source-ids");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-import-provenance");
    expect(result.issues.map((issue) => issue.code)).toContain("broken-wikilink");
    expect(result.issues.map((issue) => issue.code)).toContain("contradiction-present");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-conflict");
    expect(result.issues.map((issue) => issue.code)).toContain("open-question");
    expect(result.issues.map((issue) => issue.code)).toContain("low-confidence");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-missing-evidence");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-low-confidence");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-page");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-claim");
    expect(
      result.issuesByCategory.contradictions.some((issue) => issue.code === "claim-conflict"),
    ).toBe(true);
    expect(result.issuesByCategory["open-questions"].length).toBeGreaterThanOrEqual(2);
    expect(
      result.issuesByCategory.provenance.some(
        (issue) => issue.code === "missing-import-provenance",
      ),
    ).toBe(true);
    expect(
      result.issuesByCategory.provenance.some((issue) => issue.code === "claim-missing-evidence"),
    ).toBe(true);
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Errors");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Contradictions");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Open Questions");
  });

  it("resolves wikilinks by page title, alias, id, slug, and relative path", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-link-lint-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["entities", "sources", "syntheses"].map((dir) =>
        fs.mkdir(path.join(rootDir, dir), { recursive: true }),
      ),
    );

    await fs.writeFile(
      path.join(rootDir, "entities", "sidsel-skjold.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.sidsel-skjold",
          title: "Sidsel Skjold",
          aliases: ["Sidsel"],
          sourceIds: ["source.bridge.sidsel"],
        },
        body: "# Sidsel Skjold\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-sidsel.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.sidsel",
          title: "Bridge Sidsel",
          sourceType: "memory-bridge",
          sourcePath: "memory/2026-05-04.md",
          bridgeRelativePath: "memory/2026-05-04.md",
          bridgeWorkspaceDir: "/workspace",
        },
        body: "# Bridge Sidsel\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "link-check.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.link-check",
          title: "Link Check",
          sourceIds: ["source.bridge.sidsel"],
          updatedAt: "2099-01-01T00:00:00.000Z",
        },
        body: "# Link Check\n\n[[Sidsel Skjold]] [[Sidsel]] [[entity.sidsel-skjold]] [[sidsel-skjold]] [[entities/sidsel-skjold]] [Sidsel path](../entities/sidsel-skjold.md) [[missing-page]]\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);
    const brokenLinks = result.issues.filter(
      (issue) => issue.code === "broken-wikilink" && issue.path === "syntheses/link-check.md",
    );

    expect(brokenLinks).toHaveLength(1);
    expect(brokenLinks[0]?.message).toBe("Broken wikilink target `missing-page`.");
  });

  it("does not lint raw source page wikilinks as broken knowledge links", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-source-link-lint-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "raw-slack.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.raw-slack",
          title: "Raw Slack",
        },
        body: "# Raw Slack\n\n[[reply_to_current]] [[not-a-canonical-page]]\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issues.some((issue) => issue.code === "broken-wikilink")).toBe(false);
  });
});
