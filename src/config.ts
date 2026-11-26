import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ID_URL = "https://id.discourse.com";

/**
 * Default non-confidential OAuth client_id values keyed by normalized Discourse ID origin.
 */
export const DEFAULT_CLIENT_IDS: Record<string, string> = {
  "https://id.discourse.com": "sZzDY6daDItt71iT4w0Y2RBPn5Mo7eZS6m4Uyj1wWKM"
};

export const DEVICE_SCOPE = "read site_provision";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const TERMS_URLS = {
  free: "https://discourse.org/free-terms",
  trial: "https://discourse.org/trial-terms",
  user: "https://discourse.org/user-terms",
} as const;

export const SUBDOMAIN_REGEX = /^(?=[a-z0-9])(?=[a-z0-9-]{2,49}$)[a-z0-9-]+[a-z0-9]$/;
export const CODE_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

export const VALID_PLANS = ["free", "pro", "standard", "business"] as const;
export type Plan = (typeof VALID_PLANS)[number];

export const VALID_REGIONS = ["global", "eu"] as const;
export type Region = (typeof VALID_REGIONS)[number];

export interface PricingTier {
  name: string;
  display_name: string;
  monthly_price_cents: number | null;
  yearly_price_cents: number | null;
  trial_days: number | null;
  allows_region_selection: boolean;
  limits?: {
    pageviews?: number | null;
    storage_bytes?: number | null;
    monthly_emails?: number | null;
    daily_emails?: number | null;
  };
  plugin_count?: number | null;
  plugin_examples?: unknown;
}

export interface PricingData {
  tiers?: Record<string, PricingTier>;
}

export const FALLBACK_TIERS: Record<string, PricingTier> = {
  free: {
    name: "free",
    display_name: "Free Plan",
    monthly_price_cents: 0,
    yearly_price_cents: 0,
    trial_days: 0,
    allows_region_selection: false,
  },
  standard: {
    name: "standard",
    display_name: "Pro Plan",
    monthly_price_cents: null,
    yearly_price_cents: null,
    trial_days: 14,
    allows_region_selection: true,
  },
  business: {
    name: "business",
    display_name: "Business Plan",
    monthly_price_cents: null,
    yearly_price_cents: null,
    trial_days: 14,
    allows_region_selection: true,
  },
};

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeIdUrl(raw?: string): string {
  const value = raw?.trim() || DEFAULT_ID_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Discourse ID URL "${value}": must be a valid URL.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`Invalid Discourse ID URL "${value}": embedded credentials are not allowed.`);
  }

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost(parsed.hostname))) {
    throw new Error(
      `Invalid Discourse ID URL "${value}": must use https:// (http:// is allowed only for localhost).`,
    );
  }

  return parsed.origin;
}

export function resolveClientId(
  idUrl: string,
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromFlag = flag?.trim();
  if (fromFlag) {
    return fromFlag;
  }

  const fromEnv = env.DISCOURSE_ID_CLIENT_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  return DEFAULT_CLIENT_IDS[idUrl];
}

export function resolveConfigDir(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromFlag = flag?.trim();
  if (fromFlag) {
    return path.resolve(fromFlag);
  }

  const fromEnv = env.DISCOURSE_CREATE_SITE_CONFIG_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return path.join(path.resolve(xdg), "discourse-create-site");
  }

  return path.join(os.homedir(), ".config", "discourse-create-site");
}

export function normalizePlan(raw?: string): Plan | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  return (VALID_PLANS as readonly string[]).includes(normalized)
    ? (normalized as Plan)
    : undefined;
}

export function normalizeRegion(raw?: string): Region | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  const mapped = normalized === "europe" ? "eu" : normalized;
  return (VALID_REGIONS as readonly string[]).includes(mapped)
    ? (mapped as Region)
    : undefined;
}

export function validateSubdomain(raw: string): string | undefined {
  const normalized = raw.trim().toLowerCase();
  return SUBDOMAIN_REGEX.test(normalized) ? normalized : undefined;
}

export function slugifySubdomain(communityName: string): string {
  const slug = communityName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49)
    .replace(/-+$/g, "");

  return SUBDOMAIN_REGEX.test(slug) ? slug : "";
}

export function validateCode(raw: string): string | undefined {
  const trimmed = raw.trim();
  return CODE_REGEX.test(trimmed) ? trimmed : undefined;
}

export function termsUrlForPlan(plan: Plan): string {
  return plan === "free" ? TERMS_URLS.free : TERMS_URLS.trial;
}

export function resolveTierName(plan: Plan): string {
  return plan === "pro" ? "standard" : plan;
}

export function generateCandidateSubdomain(
  communityName: string,
  attempt = 0,
  generateSuffix: () => string = () => crypto.randomBytes(2).toString("hex"),
): string {
  const base = slugifySubdomain(communityName);
  if (attempt === 0 && base) {
    return base;
  }

  const suffix =
    generateSuffix()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 8) || "site";

  const maxPrefixLen = Math.max(2, 49 - suffix.length - 1);
  const prefix =
    (base || "community").slice(0, maxPrefixLen).replace(/-+$/g, "") || "site";

  return `${prefix}-${suffix}`;
}
