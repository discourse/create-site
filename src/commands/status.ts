import { ApiError, getSiteStatus, waitForSiteReady, type SiteStatusResponse } from "../api.js";
import { buildMcpSetup, formatMcpGuidance } from "../mcp.js";
import { isInteractive, writeJson } from "../output.js";
import type { CommandEnvironment } from "../types.js";
import {
  USER_HANDOFF_MESSAGE,
  emitAuthRequiredPrompt,
  emitError,
  resolveToken,
} from "./common.js";

export async function runStatusCommand(env: CommandEnvironment): Promise<number> {
  const siteToken = env.positionals[0]?.trim();
  if (!siteToken) {
    return emitError(
      env,
      new ApiError(400, "missing_site_token", [
        "Missing site token. Usage: discourse-create-site status <token> [--wait] [--json]",
      ]),
      1,
    );
  }

  const resolved = await resolveToken(env);
  if (!resolved) {
    return emitAuthRequiredPrompt(env);
  }

  const interactive = isInteractive({
    stdinIsTTY: env.ctx.stdinIsTTY,
    stdoutIsTTY: env.ctx.stdoutIsTTY,
    json: env.options.json,
    nonInteractive: env.options.nonInteractive,
  });

  try {
    let site: SiteStatusResponse;
    if (env.options.wait && !env.options.noWait) {
      let printedWaiting = false;
      site = await waitForSiteReady(env.options.idUrl, resolved.token, siteToken, {
        timeoutSeconds: env.options.timeoutSeconds ?? 300,
        fetchImpl: env.ctx.fetchImpl,
        sleep: env.ctx.sleep,
        now: env.ctx.now,
        onStatus(current) {
          if (!env.options.json && current.status !== "ready") {
            if (!printedWaiting) {
              env.ctx.stderr.write(`Waiting for ${current.site_url} to be ready`);
              printedWaiting = true;
            } else {
              env.ctx.stderr.write(".");
            }
          }
        },
      });
      if (!env.options.json && printedWaiting) {
        env.ctx.stderr.write("\n");
      }
    } else {
      site = await getSiteStatus(env.options.idUrl, resolved.token, siteToken, {
        fetchImpl: env.ctx.fetchImpl,
      });
    }

    const mcpSetup =
      site.status === "ready"
        ? buildMcpSetup(site.site_url, site.subdomain, env.ctx.env)
        : undefined;

    if (env.options.json) {
      if (site.status === "ready" && site.redirect_url) {
        const { site_url: _omitted, ...rest } = site;
        writeJson(env.ctx.stdout, {
          ok: true,
          ...rest,
          user_handoff: USER_HANDOFF_MESSAGE,
          mcp_setup: mcpSetup,
        });
      } else {
        writeJson(env.ctx.stdout, {
          ok: true,
          ...site,
          ...(mcpSetup ? { mcp_setup: mcpSetup } : {}),
        });
      }
      if (site.status === "ready" && site.redirect_url && env.options.open && !env.options.noOpen) {
        env.ctx.openBrowser(site.redirect_url);
      }
      return 0;
    }

    env.ctx.stdout.write(`Site: ${site.name || site.subdomain} (${site.status})\n`);
    if (site.redirect_url) {
      env.ctx.stdout.write(
        `Admin sign-in link (open this directly to claim your admin account): ${site.redirect_url}\n`,
      );
    } else {
      env.ctx.stdout.write(`Site URL: ${site.site_url}\n`);
    }

    if (mcpSetup) {
      if (site.redirect_url && !env.options.noOpen) {
        if (env.options.open) {
          env.ctx.openBrowser(site.redirect_url);
        } else if (interactive) {
          const prompter = env.ctx.prompterFactory();
          try {
            const shouldOpen = await prompter.confirm({
              message: "Open admin setup in browser?",
              defaultValue: true,
            });
            if (shouldOpen) {
              env.ctx.openBrowser(site.redirect_url);
            }
          } finally {
            prompter.close?.();
          }
        }
      }

      env.ctx.stdout.write(`\n${formatMcpGuidance(mcpSetup)}\n`);
    }

    return 0;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      if (resolved.fromCache) {
        await env.store.clearToken(env.options.idUrl);
      }
      return emitAuthRequiredPrompt(env, "Your Discourse ID session expired. Please authenticate again.");
    }
    return emitError(env, error, 1);
  }
}
