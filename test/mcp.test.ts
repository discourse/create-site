import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMcpSetup,
  detectAgentClient,
  formatMcpGuidance,
  POST_MCP_SETUP_NOTE,
} from "../src/mcp.js";

describe("MCP setup and agent detection", () => {
  it("detects supported agents and falls back to generic", () => {
    assert.deepEqual(detectAgentClient({}), { id: "generic", name: "Generic MCP Client" });
    assert.deepEqual(detectAgentClient({ CLAUDECODE: "1" }), {
      id: "claude_code",
      name: "Claude Code",
    });
    assert.deepEqual(detectAgentClient({ CODEX_THREAD_ID: "t-1" }), {
      id: "codex",
      name: "Codex",
    });
    assert.deepEqual(detectAgentClient({ GEMINI_CLI: "1" }), {
      id: "gemini_cli",
      name: "Gemini CLI",
    });
    assert.deepEqual(detectAgentClient({ CURSOR_AGENT: "1" }), {
      id: "cursor",
      name: "Cursor",
    });
    assert.deepEqual(detectAgentClient({ OPENCODE: "1" }), {
      id: "opencode",
      name: "OpenCode",
    });
    assert.deepEqual(detectAgentClient({ ANTIGRAVITY_CLI_ALIAS: "agy" }), {
      id: "antigravity",
      name: "Antigravity",
    });
    assert.deepEqual(detectAgentClient({ CLAUDECODE: "   " }), {
      id: "generic",
      name: "Generic MCP Client",
    });
  });

  it("builds in-session MCP handoff guidance without printing external CLI commands", () => {
    const setup = buildMcpSetup("https://my-forum.discourse.group/some/path", "my-forum", {});
    assert.equal(
      setup.admin_mcp_url,
      "https://my-forum.discourse.group/admin/config/mcp/settings",
    );
    assert.equal(setup.mcp_endpoint, "https://my-forum.discourse.group/mcp");
    assert.equal(
      setup.oauth_metadata_url,
      "https://my-forum.discourse.group/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(setup.transport, "streamable-http");
    assert.equal(setup.user_prompt_suggestion, "now add mcp support");
    assert.equal(
      POST_MCP_SETUP_NOTE,
      "Restart your coding agents after the setup. Most agents read their skills directory and MCP configuration at startup.",
    );
    assert.equal(setup.post_setup_note, POST_MCP_SETUP_NOTE);
    assert.match(setup.agent_instructions, /Do NOT tell the user to run a separate command outside this session/);
    assert.match(setup.agent_instructions, /now add mcp support/);
    assert.match(setup.agent_instructions, /https:\/\/my-forum\.discourse\.group\/mcp/);
    assert.match(setup.agent_instructions, /Once MCP setup is confirmed/);
    assert.ok(setup.agent_instructions.includes(POST_MCP_SETUP_NOTE));
    assert.equal(setup.detected_client.id, "generic");
    assert.equal(setup.client_instructions.command, undefined);
    assert.deepEqual(setup.client_instructions.config_snippet, {
      name: "my-forum",
      transport: "http",
      url: "https://my-forum.discourse.group/mcp",
    });

    const formatted = formatMcpGuidance(setup);
    assert.equal(formatted.includes("claude mcp add"), false);
    assert.equal(formatted.includes("codex mcp add"), false);
    assert.match(formatted, /^\s+https:\/\/my-forum\.discourse\.group\/admin\/config\/mcp\/settings$/m);
    assert.match(formatted, /now add mcp support/);
    assert.ok(
      formatted.indexOf("https://my-forum.discourse.group/admin/config/mcp/settings") <
        formatted.indexOf("now add mcp support"),
    );
    assert.match(formatted, /Streamable HTTP/);
    assert.match(formatted, /https:\/\/my-forum\.discourse\.group\/mcp/);
    assert.ok(formatted.includes(POST_MCP_SETUP_NOTE));
    assert.ok(formatted.indexOf(setup.mcp_endpoint) < formatted.indexOf(POST_MCP_SETUP_NOTE));
  });

  it("tailors internal client_instructions while keeping user-facing guidance in-session", () => {
    const claude = buildMcpSetup("https://my-forum.discourse.group", "my-forum", {
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });
    assert.equal(
      claude.client_instructions.command,
      "claude mcp add --transport http my-forum https://my-forum.discourse.group/mcp",
    );
    assert.equal(formatMcpGuidance(claude).includes("claude mcp add"), false);
    assert.match(formatMcpGuidance(claude), /now add mcp support/);

    const codex = buildMcpSetup("https://my-forum.discourse.group", "my-forum", {
      CODEX_SANDBOX: "seatbelt",
    });
    assert.equal(
      codex.client_instructions.command,
      "codex mcp add my-forum --url https://my-forum.discourse.group/mcp",
    );
    assert.equal(formatMcpGuidance(codex).includes("codex mcp add"), false);
    assert.match(formatMcpGuidance(codex), /now add mcp support/);

    const gemini = buildMcpSetup("https://my-forum.discourse.group", "my-forum", {
      GEMINI_CLI: "1",
    });
    assert.equal(
      gemini.client_instructions.command,
      "gemini mcp add --transport http my-forum https://my-forum.discourse.group/mcp",
    );

    const cursor = buildMcpSetup("https://my-forum.discourse.group", "my-forum", {
      CURSOR_CLI: "1",
    });
    assert.deepEqual(cursor.client_instructions.config_snippet, {
      mcpServers: {
        "my-forum": {
          url: "https://my-forum.discourse.group/mcp",
        },
      },
    });

    const opencode = buildMcpSetup("https://my-forum.discourse.group", "my-forum", {
      OPENCODE_CLIENT: "desktop",
    });
    assert.deepEqual(opencode.client_instructions.config_snippet, {
      mcp: {
        "my-forum": {
          type: "remote",
          url: "https://my-forum.discourse.group/mcp",
        },
      },
    });

    const antigravity = buildMcpSetup("https://my-forum.discourse.group", "my-forum", {
      ANTIGRAVITY_AGENT: "1",
    });
    assert.deepEqual(antigravity.client_instructions.config_snippet, {
      mcpServers: {
        "my-forum": {
          serverUrl: "https://my-forum.discourse.group/mcp",
        },
      },
    });
  });
});
