export type DetectedAgentId =
  | "claude_code"
  | "codex"
  | "gemini_cli"
  | "cursor"
  | "opencode"
  | "antigravity"
  | "generic";

export interface DetectedAgent {
  id: DetectedAgentId;
  name: string;
}

export interface McpClientInstruction {
  client: string;
  summary: string;
  command?: string;
  config_snippet?: Record<string, unknown>;
}

export const POST_MCP_SETUP_NOTE =
  "Restart your coding agents after the setup. Most agents read their skills directory and MCP configuration at startup.";

export interface McpSetupInfo {
  enabled_by_default: false;
  admin_mcp_url: string;
  site_setting: "mcp_server_enabled";
  transport: "streamable-http";
  mcp_endpoint: string;
  oauth_metadata_url: string;
  user_prompt_suggestion: "now add mcp support";
  agent_instructions: string;
  post_setup_note: string;
  detected_client: DetectedAgent;
  steps: string[];
  client_instructions: McpClientInstruction;
}

function hasNonEmptyEnv(env: NodeJS.ProcessEnv, ...keys: string[]): boolean {
  return keys.some((key) => Boolean(env[key]?.trim()));
}

export function detectAgentClient(env: NodeJS.ProcessEnv = process.env): DetectedAgent {
  if (hasNonEmptyEnv(env, "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")) {
    return { id: "claude_code", name: "Claude Code" };
  }
  if (
    hasNonEmptyEnv(
      env,
      "CODEX_THREAD_ID",
      "CODEX_SANDBOX",
      "CODEX_CI",
      "CODEX_MANAGED_BY_NPM",
    )
  ) {
    return { id: "codex", name: "Codex" };
  }
  if (hasNonEmptyEnv(env, "GEMINI_CLI")) {
    return { id: "gemini_cli", name: "Gemini CLI" };
  }
  if (hasNonEmptyEnv(env, "CURSOR_AGENT", "CURSOR_CLI")) {
    return { id: "cursor", name: "Cursor" };
  }
  if (hasNonEmptyEnv(env, "OPENCODE", "OPENCODE_CLIENT")) {
    return { id: "opencode", name: "OpenCode" };
  }
  if (hasNonEmptyEnv(env, "ANTIGRAVITY_CLI_ALIAS", "ANTIGRAVITY_AGENT")) {
    return { id: "antigravity", name: "Antigravity" };
  }
  return { id: "generic", name: "Generic MCP Client" };
}

function buildClientInstructions(
  detected: DetectedAgent,
  subdomain: string,
  mcpEndpoint: string,
): McpClientInstruction {
  switch (detected.id) {
    case "claude_code":
      return {
        client: detected.name,
        summary: `Add the Discourse MCP server in ${detected.name}:`,
        command: `claude mcp add --transport http ${subdomain} ${mcpEndpoint}`,
      };
    case "codex":
      return {
        client: detected.name,
        summary: `Add the Discourse MCP server in ${detected.name}:`,
        command: `codex mcp add ${subdomain} --url ${mcpEndpoint}`,
      };
    case "gemini_cli":
      return {
        client: detected.name,
        summary: `Add the Discourse MCP server in ${detected.name}:`,
        command: `gemini mcp add --transport http ${subdomain} ${mcpEndpoint}`,
      };
    case "cursor":
      return {
        client: detected.name,
        summary: `Add this server entry to your ${detected.name} MCP configuration:`,
        config_snippet: {
          mcpServers: {
            [subdomain]: {
              url: mcpEndpoint,
            },
          },
        },
      };
    case "opencode":
      return {
        client: detected.name,
        summary: `Add this remote MCP entry to your ${detected.name} configuration:`,
        config_snippet: {
          mcp: {
            [subdomain]: {
              type: "remote",
              url: mcpEndpoint,
            },
          },
        },
      };
    case "antigravity":
      return {
        client: detected.name,
        summary: `Add this server entry to your ${detected.name} MCP configuration:`,
        config_snippet: {
          mcpServers: {
            [subdomain]: {
              serverUrl: mcpEndpoint,
            },
          },
        },
      };
    case "generic":
      return {
        client: detected.name,
        summary:
          "Configure a remote Streamable HTTP MCP server in your AI client using the endpoint below (OAuth 2.0 auto-discovery is supported):",
        config_snippet: {
          name: subdomain,
          transport: "http",
          url: mcpEndpoint,
        },
      };
  }
}

export function buildMcpSetup(
  siteUrl: string,
  subdomain: string,
  env: NodeJS.ProcessEnv = process.env,
): McpSetupInfo {
  const origin = new URL(siteUrl).origin;
  const adminMcpUrl = `${origin}/admin/config/mcp/settings`;
  const mcpEndpoint = `${origin}/mcp`;
  const oauthMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const detectedClient = detectAgentClient(env);
  const userPromptSuggestion = "now add mcp support" as const;

  return {
    enabled_by_default: false,
    admin_mcp_url: adminMcpUrl,
    site_setting: "mcp_server_enabled",
    transport: "streamable-http",
    mcp_endpoint: mcpEndpoint,
    oauth_metadata_url: oauthMetadataUrl,
    user_prompt_suggestion: userPromptSuggestion,
    agent_instructions: `Do NOT tell the user to run a separate command outside this session. Tell the user to enable MCP (\`mcp_server_enabled\`) at ${adminMcpUrl} after admin sign-in, then reply "${userPromptSuggestion}". When the user replies, add/configure the remote Streamable HTTP MCP server "${subdomain}" for ${mcpEndpoint} (OAuth discovery: ${oauthMetadataUrl}) directly in this environment. Once MCP setup is confirmed, include this note: "${POST_MCP_SETUP_NOTE}"`,
    post_setup_note: POST_MCP_SETUP_NOTE,
    detected_client: detectedClient,
    steps: [
      "Open the admin sign-in link directly to claim and finish setting up your admin account.",
      `Once admin sign-in is complete, enable MCP (\`mcp_server_enabled\`) at ${adminMcpUrl}`,
      `Once enabled, reply "${userPromptSuggestion}" here so your agent adds MCP for ${mcpEndpoint}.`,
    ],
    client_instructions: buildClientInstructions(detectedClient, subdomain, mcpEndpoint),
  };
}

export function formatMcpGuidance(setup: McpSetupInfo): string {
  return [
    "Enable Discourse MCP on your new community:",
    `  1. ${setup.steps[0]}`,
    "  2. Once admin sign-in is complete, enable MCP (`mcp_server_enabled`):",
    `     ${setup.admin_mcp_url}`,
    `  3. Once enabled, tell your AI agent: "${setup.user_prompt_suggestion}"`,
    `     MCP endpoint (Streamable HTTP): ${setup.mcp_endpoint}`,
    `  Note: ${setup.post_setup_note}`,
  ].join("\n");
}
