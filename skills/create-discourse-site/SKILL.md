---
name: create-discourse-site
description: Provision a new hosted Discourse community (Free, Pro, or Business) via Discourse ID and connect Discourse MCP using @discourse/create-site. Use when the user asks to create, start, spin up, or host a Discourse forum or community.
---

# Create a Hosted Discourse Community

Use the `@discourse/create-site` CLI in `--json` mode to authenticate via Discourse ID (RFC 8628 device flow), provision a hosted community, and configure Discourse MCP in-session.

## Rules

1. **Always pass `--json`** so the CLI never blocks waiting for interactive stdin and returns structured exit codes (`0` = success, `1` = error, `2` = user action required).
2. **Two-step create flow:** Ask **only** for the community name and desired plan (`free`, `pro`, `business`) first. Once Step 2 returns `terms_urls`, present those exact URLs and wait for explicit user agreement before passing `--accept-terms` / `--accept-account-terms`.
3. **Skip subdomain and region by default:** Subdomain is auto-generated from the community name (with automatic collision retry), and region defaults to `global`. Only pass `--subdomain` or `--region` if the user explicitly asks to customize them.
4. **Never inspect or echo credentials:** Do not read `state.json` or print raw `access_token` or `device_code` values.

## Step-by-Step Workflow

### 1. Authenticate and check Step 1 options

Run:

```bash
npx -y @discourse/create-site create --json
```

- If exit code `2` with `code: "auth_required"`:
  - Show the user `verification_uri_complete` and `user_code` and ask them to approve in their browser (or run `npx -y @discourse/create-site auth start --signup --json` if they need a new Discourse ID account).
  - After they approve, run `npx -y @discourse/create-site auth poll --json`, then re-run `npx -y @discourse/create-site create --json`.
- If exit code `2` with `code: "missing_input"` (`step: 1`):
  - From `available_plans`, ask the user only for their **community name** and **plan** (`free`, `pro`, or `business`; mention the trial duration for paid plans).

### 2. Fetch plan-specific legal terms

Run:

```bash
npx -y @discourse/create-site create \
  --name "<Community Name>" \
  --plan <plan> \
  [--subdomain "<custom-slug>"] \
  [--region <global|eu>] \
  --json
```

This exits `2` with `code: "terms_required"` (`step: 2`) and returns `terms_urls` (`terms_urls.hosting`, plus `terms_urls.user` if `user_terms_needed` is `true`). Present the exact URL(s) to the user and ask for explicit confirmation.

### 3. Provision the site

After explicit confirmation, run:

```bash
npx -y @discourse/create-site create \
  --name "<Community Name>" \
  --plan <plan> \
  --accept-terms \
  [--accept-account-terms] \
  [--subdomain "<custom-slug>"] \
  [--region <global|eu>] \
  --json
```

Pass `--accept-account-terms` only when `user_terms_needed` was `true`.

## Post-Provisioning Handoff

Once `create` exits `0`:

1. **Share ONLY `redirect_url`** as a clickable link so the user can claim and sign in to their admin account (do not also share the bare `https://<subdomain>.discourse.group` URL).
2. Next, tell the user that after completing admin sign-in they should enable MCP (`mcp_server_enabled`) at `mcp_setup.admin_mcp_url` (`<site_origin>/admin/config/mcp/settings`), then reply `"now add mcp support"`. **Do not** tell the user to run a separate CLI command outside the session.
3. When the user replies `"now add mcp support"`, follow `mcp_setup.agent_instructions` (using `mcp_setup.client_instructions` as reference) to configure `mcp_setup.mcp_endpoint` directly.
4. Once MCP setup is confirmed, include this note:

> Restart your coding agents after the setup. Most agents read their skills directory and MCP configuration at startup.

## Discovery & Documentation

- Discourse ID agent auth & API guide: `https://id.discourse.com/auth.md`
- Discourse LLM discovery index: `https://www.discourse.org/llms.txt`
