# Agent Playbook: `@discourse/create-site`

Follow this playbook when provisioning a Discourse hosted site on behalf of a user. Your goal is to minimize user round-trips and never leak credentials or bypass legal terms acceptance.

## Rules

1. **Always pass `--json`** so the CLI never blocks waiting for interactive stdin and returns structured exit codes (`0` = done, `1` = error, `2` = user action required).
2. **Two-step create flow:** Ask ONLY for community name and plan first, then show the plan-specific terms URLs in a separate confirmation message before creating the site.
3. **Never invent or auto-accept legal terms.** Only pass `--accept-terms` and `--accept-account-terms` after the user explicitly confirms the URLs returned in Step 2 (`terms_urls`).
4. **Skip subdomain and region by default:** Subdomain is automatically generated from the community name (with automatic collision retry), and region defaults to `global`. Only pass `--subdomain` or `--region` if the user explicitly asks to customize them.
5. **Never inspect or echo `state.json`.** Raw `access_token` and `device_code` values are intentionally omitted from CLI output.

## Minimal Agent Flow

### 1. Authenticate (if needed) & check Step 1 options
Run:
```bash
discourse-create-site create --json
```
- If exit code is `2` with `code: "auth_required"`:
  - Present `verification_uri_complete` and `user_code` to the user and ask them to approve in their browser (or re-run `auth start --signup --json` if they need a new Discourse ID account).
  - Once they approve, run `discourse-create-site auth poll --json`, then re-run `discourse-create-site create --json`.
- If exit code is `2` with `code: "missing_input"` (`step: 1`):
  - From `available_plans`, ask the user **ONLY** for:
    - Community name (`--name`)
    - Desired plan (`--plan`: `free`, `pro`, `business`; mention trial duration for paid plans)
  - Do **not** ask for subdomain or server region unless the user brings them up.

### 2. Fetch Step 2 terms for the chosen plan
Run:
```bash
discourse-create-site create \
  --name "<Community Name>" \
  --plan <plan> \
  [--subdomain "<custom-slug>"] \
  [--region <global|eu>] \
  --json
```
- This exits `2` with `code: "terms_required"` (`step: 2`), returning the exact `terms_urls` for the chosen plan (`terms_urls.hosting`, plus `terms_urls.user` when `user_terms_needed` is `true`).
- Show the user those exact URL(s) in a separate confirmation step and ask them to agree.

### 3. Provision the site
Once confirmed, run:
```bash
discourse-create-site create \
  --name "<Community Name>" \
  --plan <plan> \
  --accept-terms \
  [--accept-account-terms] \
  [--subdomain "<custom-slug>"] \
  [--region <global|eu>] \
  --json
```
- Only pass `--accept-account-terms` when `user_terms_needed` was `true`.
- If an explicit `--subdomain` fails with exit `2` (`code: "subdomain_taken"`), ask the user for another `--subdomain` and re-run `create`.
- Otherwise exit `0` returns:
  - `redirect_url`: One-time admin sign-in invite link (share ONLY this URL with the user)
  - `user_handoff`: Reminder to share only `redirect_url`
  - `mcp_setup`: Machine-readable MCP setup guidance (`admin_mcp_url`, `site_setting`, `transport`, `mcp_endpoint`, `oauth_metadata_url`, `user_prompt_suggestion`, `agent_instructions`, `detected_client`, `steps`, `client_instructions`)

### 4. Post-provisioning handoff
Share cleanly with the user in this order:
1. **Share ONLY `redirect_url`** as a clickable link to open the new site (do not also share the bare `https://<subdomain>.discourse.group` URL, because the user must open `redirect_url` directly to claim and sign in to their admin account).
2. Next, tell the user that once admin sign-in is complete, they should enable MCP (`mcp_server_enabled`) at a clickable link to `mcp_setup.admin_mcp_url` (`<site_origin>/admin/config/mcp/settings`).
3. **Do NOT tell the user to run a separate CLI command outside the session.** Instead, tell them to reply `"now add mcp support"` once MCP is enabled.
4. When the user replies `"now add mcp support"`, follow `mcp_setup.agent_instructions` (using `mcp_setup.client_instructions` as reference if applicable) to add MCP for `mcp_setup.mcp_endpoint` directly.
