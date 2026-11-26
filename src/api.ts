import {
  DEVICE_GRANT_TYPE,
  DEVICE_SCOPE,
  type Plan,
  type PricingData,
  type Region,
} from "./config.js";
import type { PendingDeviceAuth, StoredToken } from "./store.js";
import type { FetchLike, NowLike, SleepLike } from "./types.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly errors: string[],
    public readonly retryAfterSeconds?: number,
  ) {
    super(errors[0] || `HTTP ${status}`);
    this.name = "ApiError";
  }
}

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type DevicePollResult =
  | { status: "approved"; token: StoredToken }
  | { status: "authorization_pending" }
  | { status: "slow_down" }
  | { status: "expired_token" }
  | { status: "access_denied" }
  | { status: "invalid_grant"; message: string };

export interface CliInfoUser {
  email: string;
  username: string;
  preferred_username?: string | null;
  age_terms_agreed: boolean;
  user_terms_agreed: boolean;
  identity_setup_complete: boolean;
}

export interface CliInfoResponse {
  provisioning_enabled: boolean;
  user: CliInfoUser;
  pricing: PricingData | null;
}

export interface CreateSiteInput {
  community_name: string;
  subdomain: string;
  plan: Plan;
  region?: Region;
  legal_agreed: boolean;
  age_terms_agreed?: boolean;
  user_terms_agreed?: boolean;
  email_opt_in?: boolean;
  coupon_code?: string;
  referral_code?: string;
}

export interface SiteSummary {
  token: string;
  name: string;
  subdomain: string;
  status: string;
  site_url: string;
}

export interface SiteStatusResponse extends SiteSummary {
  redirect_url: string | null;
}

const MAX_TRANSIENT_POLL_ERRORS = 5;

function parseRetryAfter(response: Response, body: Record<string, unknown> | null): number | undefined {
  const header = response.headers.get("Retry-After");
  if (header) {
    const num = Number(header);
    if (Number.isFinite(num) && num > 0) {
      return Math.ceil(num);
    }
  }
  const extras = body?.extras;
  if (extras && typeof extras === "object" && "wait_seconds" in extras) {
    const wait = Number((extras as Record<string, unknown>).wait_seconds);
    if (Number.isFinite(wait) && wait > 0) {
      return Math.ceil(wait);
    }
  }
  return undefined;
}

function extractErrors(status: number, body: Record<string, unknown> | null, rawText: string): string[] {
  if (body) {
    if (Array.isArray(body.errors)) {
      const strs = body.errors.filter((e): e is string => typeof e === "string" && e.length > 0);
      if (strs.length > 0) {
        return strs;
      }
    }
    if (typeof body.error_description === "string" && body.error_description.length > 0) {
      return [body.error_description];
    }
    if (typeof body.error === "string" && body.error.length > 0) {
      return [body.error];
    }
    if (typeof body.message === "string" && body.message.length > 0) {
      return [body.message];
    }
  }
  if (rawText.trim()) {
    return [`HTTP ${status}: ${rawText.trim().slice(0, 200)}`];
  }
  return [`Request failed with HTTP ${status}`];
}

function classifyApiError(
  status: number,
  body: Record<string, unknown> | null,
  rawText: string,
  response: Response,
): ApiError {
  const errors = extractErrors(status, body, rawText);
  const retryAfter = status === 429 ? parseRetryAfter(response, body) : undefined;

  if (status === 401) {
    return new ApiError(status, "unauthorized", errors);
  }
  if (status === 403) {
    if (body?.error === "insufficient_scope") {
      return new ApiError(status, "insufficient_scope", errors);
    }
    if (errors.some((e) => /provisioning.*disabled/i.test(e))) {
      return new ApiError(status, "provisioning_disabled", errors);
    }
    return new ApiError(status, "forbidden", errors);
  }
  if (status === 404) {
    return new ApiError(status, "not_found", errors);
  }
  if (status === 422) {
    if (errors.some((e) => /subdomain.*taken|domain.*taken/i.test(e))) {
      return new ApiError(status, "subdomain_taken", errors);
    }
    return new ApiError(status, "validation_error", errors);
  }
  if (status === 429) {
    return new ApiError(status, "rate_limited", errors, retryAfter);
  }
  if (status === 400 && typeof body?.error === "string") {
    return new ApiError(status, body.error, errors);
  }
  if (status >= 500) {
    return new ApiError(status, "server_error", errors);
  }
  return new ApiError(status, "api_error", errors);
}

async function readJsonResponse(response: Response): Promise<{
  body: Record<string, unknown> | null;
  rawText: string;
}> {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return { body: null, rawText };
  }
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { body: parsed as Record<string, unknown>, rawText };
    }
    return { body: null, rawText };
  } catch {
    return { body: null, rawText };
  }
}

async function safeFetch(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, "network_error", [`Network error calling ${url}: ${msg}`]);
  }
}

export async function startDeviceAuth(
  idUrl: string,
  clientId: string,
  options: { signup?: boolean; fetchImpl?: FetchLike } = {},
): Promise<DeviceAuthResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: DEVICE_SCOPE,
  });

  const response = await safeFetch(fetchImpl, `${idUrl}/oauth/authorize_device`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  const { body, rawText } = await readJsonResponse(response);
  if (!response.ok) {
    throw classifyApiError(response.status, body, rawText, response);
  }

  if (
    !body ||
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    throw new ApiError(response.status, "invalid_response", [
      "Invalid device authorization response from server.",
    ]);
  }

  const rawComplete =
    typeof body.verification_uri_complete === "string" && body.verification_uri_complete
      ? body.verification_uri_complete
      : (() => {
          const fallback = new URL(body.verification_uri);
          fallback.searchParams.set("user_code", body.user_code);
          return fallback.toString();
        })();

  const completeUrl = new URL(rawComplete);
  if (options.signup) {
    completeUrl.searchParams.set("intent", "signup");
  }

  const expiresIn =
    typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 600;
  const interval = typeof body.interval === "number" && body.interval > 0 ? body.interval : 5;

  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    verification_uri_complete: completeUrl.toString(),
    expires_in: expiresIn,
    interval,
  };
}

export async function pollDeviceTokenOnce(
  idUrl: string,
  clientId: string,
  deviceCode: string,
  options: { fetchImpl?: FetchLike; now?: NowLike } = {},
): Promise<DevicePollResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  const params = new URLSearchParams({
    grant_type: DEVICE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: clientId,
  });

  const response = await safeFetch(fetchImpl, `${idUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  const { body, rawText } = await readJsonResponse(response);

  if (response.ok) {
    if (!body || typeof body.access_token !== "string") {
      throw new ApiError(response.status, "invalid_response", [
        "Token response did not contain an access_token.",
      ]);
    }
    const createdAtMs =
      typeof body.created_at === "number" && body.created_at > 0
        ? body.created_at * 1000
        : now();
    const expiresInSec =
      typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 7200;

    return {
      status: "approved",
      token: {
        accessToken: body.access_token,
        tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
        scope: typeof body.scope === "string" ? body.scope : DEVICE_SCOPE,
        createdAt: createdAtMs,
        expiresAt: createdAtMs + expiresInSec * 1000,
      },
    };
  }

  if (response.status === 400 || response.status === 429) {
    const errorCode = typeof body?.error === "string" ? body.error : undefined;
    if (errorCode === "authorization_pending") {
      return { status: "authorization_pending" };
    }
    if (errorCode === "slow_down" || response.status === 429) {
      return { status: "slow_down" };
    }
    if (errorCode === "expired_token") {
      return { status: "expired_token" };
    }
    if (errorCode === "access_denied") {
      return { status: "access_denied" };
    }
    if (errorCode === "invalid_grant") {
      return {
        status: "invalid_grant",
        message: extractErrors(response.status, body, rawText)[0],
      };
    }
  }

  throw classifyApiError(response.status, body, rawText, response);
}

export async function pollDeviceTokenUntilApproved(
  idUrl: string,
  clientId: string,
  pending: PendingDeviceAuth,
  options: {
    timeoutSeconds?: number;
    fetchImpl?: FetchLike;
    sleep?: SleepLike;
    now?: NowLike;
    onPoll?: () => void;
  } = {},
): Promise<StoredToken> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const timeoutMs = (options.timeoutSeconds ?? Math.ceil((pending.expiresAt - now()) / 1000)) * 1000;
  const start = now();
  const deadline = Math.min(pending.expiresAt, start + timeoutMs);

  let intervalSeconds = Math.max(1, pending.interval || 5);
  let shouldSleepBeforePoll = now() - pending.createdAt < 1000;
  let transientErrors = 0;

  while (true) {
    if (shouldSleepBeforePoll) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new ApiError(408, "auth_timeout", [
          "Timed out waiting for Discourse ID authorization.",
        ]);
      }
      await sleep(Math.min(intervalSeconds * 1000, remaining));
    }
    shouldSleepBeforePoll = true;

    if (now() > deadline) {
      throw new ApiError(408, "auth_timeout", [
        "Timed out waiting for Discourse ID authorization.",
      ]);
    }

    options.onPoll?.();

    let result: DevicePollResult;
    try {
      result = await pollDeviceTokenOnce(idUrl, clientId, pending.deviceCode, {
        fetchImpl: options.fetchImpl,
        now,
      });
      transientErrors = 0;
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 0 || error.status >= 500) &&
        transientErrors < MAX_TRANSIENT_POLL_ERRORS - 1
      ) {
        transientErrors += 1;
        continue;
      }
      throw error;
    }

    switch (result.status) {
      case "approved":
        return result.token;
      case "authorization_pending":
        break;
      case "slow_down":
        intervalSeconds += 5;
        break;
      case "expired_token":
        throw new ApiError(400, "expired_token", [
          "The device authorization code has expired. Start authentication again.",
        ]);
      case "access_denied":
        throw new ApiError(400, "access_denied", ["Authorization was denied by the user."]);
      case "invalid_grant":
        throw new ApiError(400, "invalid_grant", [result.message]);
    }
  }
}

export async function getCliInfo(
  idUrl: string,
  accessToken: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<CliInfoResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await safeFetch(fetchImpl, `${idUrl}/discourse_login/cli/info`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const { body, rawText } = await readJsonResponse(response);
  if (!response.ok) {
    throw classifyApiError(response.status, body, rawText, response);
  }

  if (
    !body ||
    typeof body.provisioning_enabled !== "boolean" ||
    !body.user ||
    typeof body.user !== "object"
  ) {
    throw new ApiError(response.status, "invalid_response", [
      "Invalid info response from Discourse ID.",
    ]);
  }

  const userObj = body.user as Record<string, unknown>;
  const pricing =
    body.pricing && typeof body.pricing === "object" ? (body.pricing as PricingData) : null;

  return {
    provisioning_enabled: body.provisioning_enabled,
    user: {
      email: typeof userObj.email === "string" ? userObj.email : "",
      username: typeof userObj.username === "string" ? userObj.username : "",
      preferred_username:
        typeof userObj.preferred_username === "string" ? userObj.preferred_username : null,
      age_terms_agreed: Boolean(userObj.age_terms_agreed),
      user_terms_agreed: Boolean(userObj.user_terms_agreed),
      identity_setup_complete: Boolean(userObj.identity_setup_complete),
    },
    pricing,
  };
}

export async function createSite(
  idUrl: string,
  accessToken: string,
  input: CreateSiteInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SiteSummary> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const requestBody: Record<string, unknown> = {
    community_name: input.community_name,
    subdomain: input.subdomain,
    plan: input.plan,
    legal_agreed: input.legal_agreed,
    email_opt_in: Boolean(input.email_opt_in),
  };

  if (input.region) {
    requestBody.region = input.region;
  }
  if (input.age_terms_agreed === true) {
    requestBody.age_terms_agreed = true;
  }
  if (input.user_terms_agreed === true) {
    requestBody.user_terms_agreed = true;
  }
  if (input.coupon_code) {
    requestBody.coupon_code = input.coupon_code;
  }
  if (input.referral_code) {
    requestBody.referral_code = input.referral_code;
  }

  const response = await safeFetch(fetchImpl, `${idUrl}/discourse_login/cli/sites`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const { body, rawText } = await readJsonResponse(response);
  if (!response.ok) {
    throw classifyApiError(response.status, body, rawText, response);
  }

  if (!body || typeof body.token !== "string" || typeof body.subdomain !== "string") {
    throw new ApiError(response.status, "invalid_response", [
      "Invalid site creation response from Discourse ID.",
    ]);
  }

  return {
    token: body.token,
    name: typeof body.name === "string" ? body.name : input.community_name,
    subdomain: body.subdomain,
    status: typeof body.status === "string" ? body.status : "in_progress",
    site_url:
      typeof body.site_url === "string"
        ? body.site_url
        : `https://${body.subdomain}.discourse.group`,
  };
}

export async function getSiteStatus(
  idUrl: string,
  accessToken: string,
  siteToken: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SiteStatusResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await safeFetch(
    fetchImpl,
    `${idUrl}/discourse_login/cli/sites/${encodeURIComponent(siteToken)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  const { body, rawText } = await readJsonResponse(response);
  if (!response.ok) {
    throw classifyApiError(response.status, body, rawText, response);
  }

  if (!body || typeof body.token !== "string" || typeof body.subdomain !== "string") {
    throw new ApiError(response.status, "invalid_response", [
      "Invalid site status response from Discourse ID.",
    ]);
  }

  return {
    token: body.token,
    name: typeof body.name === "string" ? body.name : "",
    subdomain: body.subdomain,
    status: typeof body.status === "string" ? body.status : "in_progress",
    site_url:
      typeof body.site_url === "string"
        ? body.site_url
        : `https://${body.subdomain}.discourse.group`,
    redirect_url: typeof body.redirect_url === "string" ? body.redirect_url : null,
  };
}

export async function waitForSiteReady(
  idUrl: string,
  accessToken: string,
  siteToken: string,
  options: {
    timeoutSeconds?: number;
    pollIntervalMs?: number;
    fetchImpl?: FetchLike;
    sleep?: SleepLike;
    now?: NowLike;
    onStatus?: (status: SiteStatusResponse) => void;
  } = {},
): Promise<SiteStatusResponse> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const timeoutMs = (options.timeoutSeconds ?? 300) * 1000;
  const deadline = now() + timeoutMs;

  let consecutiveTransientErrors = 0;

  while (true) {
    let waitMs = pollIntervalMs;

    try {
      const site = await getSiteStatus(idUrl, accessToken, siteToken, {
        fetchImpl: options.fetchImpl,
      });
      consecutiveTransientErrors = 0;
      options.onStatus?.(site);

      if (site.status === "ready") {
        return site;
      }
      if (site.status === "failed") {
        throw new ApiError(422, "provisioning_failed", ["Site provisioning failed."]);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        waitMs = (error.retryAfterSeconds ?? Math.ceil((pollIntervalMs * 2) / 1000)) * 1000;
      } else if (
        error instanceof ApiError &&
        (error.status === 0 || error.status >= 500) &&
        consecutiveTransientErrors < MAX_TRANSIENT_POLL_ERRORS - 1
      ) {
        consecutiveTransientErrors += 1;
      } else {
        throw error;
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new ApiError(408, "provisioning_timeout", [
        "Timed out waiting for site provisioning to complete.",
      ]);
    }
    await sleep(Math.min(waitMs, remaining));
  }
}
