import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { POST_MCP_SETUP_NOTE } from "../src/mcp.js";

describe("create-discourse-site Agent Skill", () => {
  it("provides valid SKILL.md frontmatter and provisioning instructions", async () => {
    const skillPath = path.resolve(
      process.cwd(),
      "skills/create-discourse-site/SKILL.md",
    );
    const content = await fs.readFile(skillPath, "utf8");

    assert.match(content, /^---\n[\s\S]*?\n---\n/);
    assert.match(content, /^name:\s*create-discourse-site$/m);
    assert.match(content, /^description:\s*\S+/m);

    assert.ok(content.includes("npx -y @discourse/create-site"));
    assert.ok(content.includes("--json"));
    assert.ok(content.includes("redirect_url"));
    assert.ok(content.includes("now add mcp support"));
    assert.ok(content.includes("https://id.discourse.com/auth.md"));
    assert.ok(content.includes(POST_MCP_SETUP_NOTE));
  });
});
