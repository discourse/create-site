import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ApiError,
  createSite,
  getCliInfo,
  pollDeviceTokenUntilApproved,
  startDeviceAuth,
  waitForSiteReady,
} from "../src/api.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("API client", () => {
  it("starts device auth and adds intent=signup when requested", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? "");
      return jsonResponse(200, {
        device_code: "dev-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://id.discourse.com/oauth/device",
        verification_uri_complete:
          "https://id.discourse.com/oauth/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      });
    };

    const res = await startDeviceAuth("https://id.discourse.com", "uid-1", {
      signup: true,
      fetchImpl,
    });

    assert.equal(seenUrl, "https://id.discourse.com/oauth/authorize_device");
    assert.match(seenBody, /client_id=uid-1/);
    assert.match(seenBody, /scope=read\+site_provision/);
    assert.equal(
      res.verification_uri_complete,
      "https://id.discourse.com/oauth/device?user_code=ABCD-EFGH&intent=signup",
    );
  });

  it("handles authorization_pending and slow_down interval backoff during polling", async () => {
    const responses = [
      jsonResponse(400, { error: "authorization_pending" }),
      jsonResponse(400, { error: "slow_down" }),
      jsonResponse(200, {
        access_token: "tok-abc",
        token_type: "Bearer",
        expires_in: 7200,
        scope: "read site_provision",
        created_at: 1_700_000_020,
      }),
    ];
    let idx = 0;
    const sleeps: number[] = [];
    let currentTime = 1_700_000_000_000;

    const token = await pollDeviceTokenUntilApproved(
      "https://id.discourse.com",
      "uid-1",
      {
        deviceCode: "dev-1",
        userCode: "ABCD-EFGH",
        verificationUri: "https://id.discourse.com/oauth/device",
        verificationUriComplete: "https://id.discourse.com/oauth/device?user_code=ABCD-EFGH",
        clientId: "uid-1",
        interval: 5,
        createdAt: currentTime,
        expiresAt: currentTime + 600_000,
      },
      {
        timeoutSeconds: 120,
        fetchImpl: async () => responses[idx++],
        now: () => currentTime,
        sleep: async (ms) => {
          sleeps.push(ms);
          currentTime += ms;
        },
      },
    );

    assert.equal(token.accessToken, "tok-abc");
    assert.deepEqual(sleeps, [5000, 5000, 10000]);
  });

  it("surfaces expired_token and access_denied errors", async () => {
    for (const code of ["expired_token", "access_denied"] as const) {
      await assert.rejects(
        () =>
          pollDeviceTokenUntilApproved(
            "https://id.discourse.com",
            "uid-1",
            {
              deviceCode: "dev-1",
              userCode: "ABCD-EFGH",
              verificationUri: "https://id.discourse.com/oauth/device",
              verificationUriComplete: "https://id.discourse.com/oauth/device?user_code=ABCD-EFGH",
              clientId: "uid-1",
              interval: 5,
              createdAt: 0,
              expiresAt: 10_000_000_000_000,
            },
            {
              timeoutSeconds: 60,
              now: () => 500_000,
              sleep: async () => undefined,
              fetchImpl: async () => jsonResponse(400, { error: code }),
            },
          ),
        (err: unknown) => err instanceof ApiError && err.code === code,
      );
    }
  });

  it("tolerates null pricing in getCliInfo", async () => {
    const info = await getCliInfo("https://id.discourse.com", "tok", {
      fetchImpl: async () =>
        jsonResponse(200, {
          provisioning_enabled: true,
          user: {
            email: "a@example.com",
            username: "alice",
            age_terms_agreed: false,
            user_terms_agreed: false,
            identity_setup_complete: false,
          },
          pricing: null,
        }),
    });

    assert.equal(info.provisioning_enabled, true);
    assert.equal(info.pricing, null);
    assert.equal(info.user.email, "a@example.com");
  });

  it("omits empty coupon/referral codes in createSite and classifies 422/429 errors", async () => {
    let sentBody: Record<string, unknown> = {};
    const site = await createSite(
      "https://id.discourse.com",
      "tok",
      {
        community_name: "Test",
        subdomain: "test-site",
        plan: "pro",
        region: "eu",
        legal_agreed: true,
        age_terms_agreed: true,
        user_terms_agreed: true,
      },
      {
        fetchImpl: async (_url, init) => {
          sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse(201, {
            token: "site-tok",
            name: "Test",
            subdomain: "test-site",
            status: "in_progress",
            site_url: "https://test-site.discourse.group",
          });
        },
      },
    );

    assert.equal(site.token, "site-tok");
    assert.equal("coupon_code" in sentBody, false);
    assert.equal("referral_code" in sentBody, false);
    assert.equal(sentBody.plan, "pro");
    assert.equal(sentBody.region, "eu");

    await assert.rejects(
      () =>
        createSite(
          "https://id.discourse.com",
          "tok",
          {
            community_name: "Test",
            subdomain: "taken",
            plan: "free",
            legal_agreed: true,
          },
          {
            fetchImpl: async () => jsonResponse(422, { errors: ["Subdomain is already taken."] }),
          },
        ),
      (err: unknown) => err instanceof ApiError && err.code === "subdomain_taken",
    );

    await assert.rejects(
      () =>
        createSite(
          "https://id.discourse.com",
          "tok",
          {
            community_name: "Test",
            subdomain: "rate-limited",
            plan: "free",
            legal_agreed: true,
          },
          {
            fetchImpl: async () =>
              jsonResponse(429, { errors: ["Too many requests"] }, { "Retry-After": "12" }),
          },
        ),
      (err: unknown) =>
        err instanceof ApiError && err.code === "rate_limited" && err.retryAfterSeconds === 12,
    );
  });

  it("retries transient 503 responses in waitForSiteReady and handles reallocated subdomain", async () => {
    const outcomes: Array<() => Response> = [
      () =>
        jsonResponse(200, {
          token: "site-tok",
          name: "Test",
          subdomain: "requested",
          status: "in_progress",
          site_url: "https://requested.discourse.group",
          redirect_url: null,
        }),
      () => new Response("Service Unavailable", { status: 503 }),
      () =>
        jsonResponse(200, {
          token: "site-tok",
          name: "Test",
          subdomain: "allocated-2",
          status: "ready",
          site_url: "https://allocated-2.discourse.group",
          redirect_url: "https://allocated-2.discourse.group/invites/accept/secret",
        }),
    ];
    let idx = 0;
    let nowMs = 1000;

    const ready = await waitForSiteReady("https://id.discourse.com", "tok", "site-tok", {
      timeoutSeconds: 60,
      pollIntervalMs: 3000,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      fetchImpl: async () => outcomes[idx++](),
    });

    assert.equal(ready.status, "ready");
    assert.equal(ready.subdomain, "allocated-2");
    assert.equal(ready.site_url, "https://allocated-2.discourse.group");
  });
});
