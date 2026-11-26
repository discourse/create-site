import { ApiError, getCliInfo } from "../api.js";
import { TERMS_URLS } from "../config.js";
import { writeJson } from "../output.js";
import type { CommandEnvironment } from "../types.js";
import {
  emitAuthRequiredPrompt,
  emitError,
  filterAllowedTiers,
  formatTierHint,
  getEffectiveTiers,
  orderedTierEntries,
  resolveToken,
} from "./common.js";

export async function runInfoCommand(env: CommandEnvironment): Promise<number> {
  const resolved = await resolveToken(env);
  if (!resolved) {
    return emitAuthRequiredPrompt(env);
  }

  try {
    const info = await getCliInfo(env.options.idUrl, resolved.token, {
      fetchImpl: env.ctx.fetchImpl,
    });
    const tiers = orderedTierEntries(getEffectiveTiers(info.pricing));
    const filteredPricing = info.pricing
      ? { ...info.pricing, tiers: filterAllowedTiers(info.pricing.tiers) }
      : null;

    if (env.options.json) {
      writeJson(env.ctx.stdout, {
        ok: true,
        id_url: env.options.idUrl,
        provisioning_enabled: info.provisioning_enabled,
        user: info.user,
        pricing: filteredPricing,
        available_plans: tiers.map((tier) => ({
          plan: tier.name === "standard" ? "pro" : tier.name,
          tier: tier.name,
          display_name: tier.display_name,
          monthly_price_cents: tier.monthly_price_cents,
          yearly_price_cents: tier.yearly_price_cents,
          trial_days: tier.trial_days,
          allows_region_selection: tier.allows_region_selection,
        })),
        terms_urls: TERMS_URLS,
      });
    } else {
      env.ctx.stdout.write(`Discourse ID: ${env.options.idUrl}\n`);
      env.ctx.stdout.write(`User: ${info.user.username} <${info.user.email}>\n`);
      env.ctx.stdout.write(
        `Provisioning enabled: ${info.provisioning_enabled ? "yes" : "no"}\n`,
      );
      env.ctx.stdout.write(
        `Account terms agreed: age=${info.user.age_terms_agreed ? "yes" : "no"}, user_terms=${info.user.user_terms_agreed ? "yes" : "no"}\n`,
      );
      env.ctx.stdout.write("Plans:\n");
      for (const tier of tiers) {
        const hint = formatTierHint(tier);
        env.ctx.stdout.write(`  - ${tier.name} (${tier.display_name})${hint ? `: ${hint}` : ""}\n`);
      }
      env.ctx.stdout.write(
        `Terms URLs: free=${TERMS_URLS.free}, trial=${TERMS_URLS.trial}, user=${TERMS_URLS.user}\n`,
      );
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
