import { ApiError } from "../api.js";
import {
  FALLBACK_TIERS,
  normalizePlan,
  type PricingData,
  type PricingTier,
} from "../config.js";
import { formatCliError, writeJson } from "../output.js";
import type { StoredToken } from "../store.js";
import type { CommandEnvironment } from "../types.js";

export const USER_HANDOFF_MESSAGE =
  "Share ONLY redirect_url with the user so they open it directly to claim and sign in to their admin account. Do not share the bare site URL separately.";

export interface ResolvedToken {
  token: string;
  fromCache: boolean;
  stored?: StoredToken;
}

export async function resolveToken(env: CommandEnvironment): Promise<ResolvedToken | undefined> {
  const fromFlag = env.options.tokenFlag?.trim();
  if (fromFlag) {
    return { token: fromFlag, fromCache: false };
  }

  const fromEnv = env.ctx.env.DISCOURSE_ID_TOKEN?.trim();
  if (fromEnv) {
    return { token: fromEnv, fromCache: false };
  }

  const stored = await env.store.getValidToken(env.options.idUrl, env.ctx.now());
  if (stored) {
    return { token: stored.accessToken, fromCache: true, stored };
  }

  return undefined;
}

export function emitError(env: CommandEnvironment, error: unknown, exitCode = 1): number {
  const formatted = formatCliError(error);
  if (env.options.json) {
    writeJson(env.ctx.stdout, {
      ok: false,
      status: exitCode === 2 ? "action_required" : "error",
      code: formatted.code,
      message: formatted.message,
      errors: formatted.errors,
      ...(formatted.retryAfterSeconds !== undefined
        ? { retry_after: formatted.retryAfterSeconds }
        : {}),
    });
  } else {
    env.ctx.stderr.write(`Error (${formatted.code}): ${formatted.message}\n`);
    for (const extra of formatted.errors.slice(1)) {
      env.ctx.stderr.write(`  - ${extra}\n`);
    }
  }
  return exitCode;
}

export function emitAuthRequiredPrompt(env: CommandEnvironment, message?: string): number {
  const detail =
    message ??
    `Authentication required for ${env.options.idUrl}. Run \`discourse-create-site auth\` first.`;

  if (env.options.json) {
    writeJson(env.ctx.stdout, {
      ok: false,
      status: "action_required",
      code: "auth_required",
      id_url: env.options.idUrl,
      message: detail,
      next_steps: [
        "Run `discourse-create-site auth start --json` to get the user verification URL and code.",
        "Have the user open verification_uri_complete and approve.",
        "Run `discourse-create-site auth poll --json` to save the token.",
      ],
    });
  } else {
    env.ctx.stderr.write(`${detail}\n`);
  }
  return 2;
}

export function requireClientId(env: CommandEnvironment): string | undefined {
  const clientId = env.options.clientId?.trim();
  if (clientId) {
    return clientId;
  }

  emitError(
    env,
    new ApiError(400, "missing_client_id", [
      `No OAuth client_id configured for ${env.options.idUrl}. Pass --client-id <uid> or set DISCOURSE_ID_CLIENT_ID.`,
    ]),
    1,
  );
  return undefined;
}

export function filterAllowedTiers(
  tiers?: Record<string, PricingTier>,
): Record<string, PricingTier> {
  if (!tiers) {
    return {};
  }
  const filtered: Record<string, PricingTier> = {};
  for (const [key, tier] of Object.entries(tiers)) {
    if (normalizePlan(tier?.name ?? key)) {
      filtered[key] = tier;
    }
  }
  return filtered;
}

export function getEffectiveTiers(pricing: PricingData | null): Record<string, PricingTier> {
  const filtered = filterAllowedTiers(pricing?.tiers);
  if (Object.keys(filtered).length > 0) {
    return filtered;
  }
  return FALLBACK_TIERS;
}

export function formatTierHint(tier: PricingTier): string {
  const parts: string[] = [];
  if (tier.monthly_price_cents === 0) {
    parts.push("Free");
  } else if (typeof tier.monthly_price_cents === "number" && tier.monthly_price_cents > 0) {
    parts.push(`$${tier.monthly_price_cents / 100}/mo`);
  }
  if (typeof tier.trial_days === "number" && tier.trial_days > 0) {
    parts.push(`${tier.trial_days}-day free trial`);
  }
  if (tier.allows_region_selection) {
    parts.push("region choice");
  }
  return parts.join(", ");
}

export function orderedTierEntries(tiers: Record<string, PricingTier>): PricingTier[] {
  const order = ["free", "standard", "pro", "business"];
  return Object.values(tiers).sort((a, b) => {
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    if (ai === -1 && bi === -1) {
      return a.name.localeCompare(b.name);
    }
    if (ai === -1) {
      return 1;
    }
    if (bi === -1) {
      return -1;
    }
    return ai - bi;
  });
}
