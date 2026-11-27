# @discourse/create-site

Agent-friendly CLI wizard to provision hosted Discourse communities via Discourse ID OAuth 2.0 Device Authorization Grant (RFC 8628).

Designed primarily for LLM coding agents (`--json` mode with structured exit code `2` handoffs and zero secret leakage) while also supporting a minimal interactive TTY wizard for humans.

## Quick Start (Interactive)

```bash
npx -y @discourse/create-site
```

## Agent Workflow (`--json`)

In `--json` or non-TTY mode, the CLI **never blocks waiting for stdin** and **never prints `access_token` or `device_code` to stdout**. Credentials are stored per host with `0600` permissions in `~/.config/discourse-create-site/state.json`.

### Exit Codes
- `0`: Success
- `1`: Fatal or configuration error (`invalid_arguments`, `invalid_input`, `provisioning_disabled`, `expired_token`, `access_denied`, network/API error)
- `2`: Action required from the end user (`auth_required`, `authorization_pending`, `missing_input`, `terms_required`, `subdomain_taken`)

### Step-by-Step Agent Flow

1. **Check session & plans (or start device login if unauthenticated):**
   ```bash
   discourse-create-site create --json
   ```
   If unauthenticated, exits `2` with:
   ```json
   {
     "ok": false,
     "status": "action_required",
     "code": "auth_required",
     "user_code": "ABCD-EFGH",
     "verification_uri": "https://id.discourse.com/oauth/device",
     "verification_uri_complete": "https://id.discourse.com/oauth/device?user_code=ABCD-EFGH",
     "expires_in": 600,
     "interval": 5
   }
   ```
   Ask the user to open `verification_uri_complete` and confirm `user_code`. Pass `--signup` if the user needs to create a new Discourse ID account first.

2. **Complete device authorization:**
   ```bash
   discourse-create-site auth poll --json
   ```
   (Or use `--no-wait` for a single non-blocking poll returning exit `2` `authorization_pending` while waiting.)

3. **Step 1 — Collect community name & plan:**
   Running `create --json` with missing inputs exits `2` (`step: 1`, `code: "missing_input"`) returning `available_plans`. Ask the user ONLY for their community name and desired plan (subdomain is auto-generated from the name unless they explicitly request `--subdomain`; region defaults to `global` unless overridden with `--region`).

4. **Step 2 — Show plan-specific terms & provision:**
   Run with `--name` and `--plan` (without `--accept-terms` yet):
   ```bash
   discourse-create-site create --name "My Community" --plan free --json
   ```
   This exits `2` (`step: 2`, `code: "terms_required"`) with the exact `terms_urls` for that plan (`free-terms` or `trial-terms`, plus `user` 18+ terms if needed). After the user confirms, re-run with acceptance flags:
   ```bash
   discourse-create-site create \
     --name "My Community" \
     --plan free \
     --accept-terms \
     --accept-account-terms \
     --json
   ```
   Pass `--subdomain <slug>` and `--region <global|eu>` only if requested (or `--customize` in interactive TTY mode to be prompted for them). On completion, exits `0` with `redirect_url` (one-time admin sign-in invite link), `user_handoff` guidance (share ONLY `redirect_url` directly with the user, not the bare site URL), and `mcp_setup` tailored to the detected agent client or generic Streamable HTTP MCP configuration.

## Commands

- `discourse-create-site [create] [options]` — Provision a new community (default command)
- `discourse-create-site auth [options]` — Interactive device auth + poll
- `discourse-create-site auth start [--signup] [--open] [--json]` — Start device auth without blocking
- `discourse-create-site auth poll [--no-wait] [--timeout <s>] [--json]` — Poll for token completion
- `discourse-create-site auth status [--json]` — Check active token status
- `discourse-create-site auth logout [--all] [--json]` — Remove stored credentials
- `discourse-create-site info [--json]` — Show account details, terms status, and available plans
- `discourse-create-site status <token> [--wait] [--json]` — Check or wait for site readiness

## Configuration

| Flag | Environment Variable | Description | Default |
| --- | --- | --- | --- |
| `--id-url` | `DISCOURSE_ID_URL` | Discourse ID base URL | `https://id.discourse.com` |
| `--client-id` | `DISCOURSE_ID_CLIENT_ID` | Non-confidential OAuth `client_id` | Built-in default for https://id.discourse.com |
| `--config-dir` | `DISCOURSE_CREATE_SITE_CONFIG_DIR` | Credential storage dir | `$XDG_CONFIG_HOME/discourse-create-site` or `~/.config/discourse-create-site` |
| `--token` | `DISCOURSE_ID_TOKEN` | Explicit Bearer access token | Stored host token |

## Post-Provisioning MCP Setup

Newly provisioned sites do not enable Discourse's built-in MCP server by default yet. Once the user opens `redirect_url` directly and finishes admin sign-in:

1. Visit `<site_origin>/admin/config/mcp/settings` and enable MCP (`mcp_server_enabled`).
2. Reply `"now add mcp support"` inside your AI agent session so the agent configures `<site_origin>/mcp` (Streamable HTTP, OAuth discovery at `<site_origin>/.well-known/oauth-protected-resource/mcp`) for you without needing to run an external CLI command.
3. After MCP setup is confirmed: Restart your coding agents after the setup. Most agents read their skills directory and MCP configuration at startup.

`mcp_setup` in `--json` output includes `admin_mcp_url`, `user_prompt_suggestion` (`"now add mcp support"`), `agent_instructions`, `post_setup_note`, and `client_instructions` as a reference for the detected agent client (or generic Streamable HTTP configuration).

## Development

```bash
npm install
npm run typecheck
npm test
```
