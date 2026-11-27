import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { Prompter } from "../src/prompts.js";
import { runCli } from "../src/runner.js";
import { StateStore } from "../src/store.js";
import type { RunContext } from "../src/types.js";

const execFileAsync = promisify(execFile);

class CaptureStream extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeContext(
  argv: string[],
  options: {
    configDir: string;
    stdinIsTTY?: boolean;
    stdoutIsTTY?: boolean;
    fetchImpl?: typeof fetch;
    prompter?: Prompter;
    env?: Record<string, string>;
  },
) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const openedUrls: string[] = [];
  let currentNow = 1_700_000_000_000;

  const ctx: RunContext = {
    argv,
    env: {
      DISCOURSE_ID_URL: "https://id.discourse.com",
      DISCOURSE_ID_CLIENT_ID: "test-cli-uid",
      DISCOURSE_CREATE_SITE_CONFIG_DIR: options.configDir,
      ...options.env,
    },
    stdinIsTTY: options.stdinIsTTY ?? false,
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    stdout,
    stderr,
    fetchImpl: options.fetchImpl ?? (async () => jsonRes(500, { errors: ["unmocked"] })),
    sleep: async (ms) => {
      currentNow += ms;
    },
    now: () => currentNow,
    openBrowser: (url) => {
      openedUrls.push(url);
      return true;
    },
    prompterFactory: () => {
      if (!options.prompter) {
        throw new Error("Prompter should not be invoked in non-interactive mode");
      }
      return options.prompter;
    },
  };

  return { ctx, stdout, stderr, openedUrls };
}

describe("CLI flows", () => {
  it("runs the full agent --json workflow without leaking tokens or blocking on stdin", async (t) => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "discourse-cli-agent-"));
    t.after(() => fs.rm(configDir, { recursive: true, force: true }));

    let tokenPollCount = 0;
    let siteStatusPollCount = 0;
    const createPayloads: Array<Record<string, unknown>> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === "/oauth/authorize_device") {
        return jsonRes(200, {
          device_code: "secret-device-code",
          user_code: "WXYZ-1234",
          verification_uri: "https://id.discourse.com/oauth/device",
          verification_uri_complete:
            "https://id.discourse.com/oauth/device?user_code=WXYZ-1234",
          expires_in: 600,
          interval: 5,
        });
      }

      if (url.pathname === "/oauth/token") {
        tokenPollCount += 1;
        if (tokenPollCount === 1) {
          return jsonRes(400, { error: "authorization_pending" });
        }
        return jsonRes(200, {
          access_token: "super-secret-bearer-token",
          token_type: "Bearer",
          expires_in: 7200,
          scope: "read site_provision",
          created_at: 1_700_000_005,
        });
      }

      if (url.pathname === "/discourse_login/cli/info") {
        assert.equal(
          (init?.headers as Record<string, string>)["Authorization"],
          "Bearer super-secret-bearer-token",
        );
        return jsonRes(200, {
          provisioning_enabled: true,
          user: {
            email: "agent@example.com",
            username: "agentuser",
            age_terms_agreed: false,
            user_terms_agreed: false,
            identity_setup_complete: true,
          },
          pricing: {
            tiers: {
              free: {
                name: "free",
                display_name: "Free Plan",
                monthly_price_cents: 0,
                yearly_price_cents: 0,
                trial_days: 0,
                allows_region_selection: false,
              },
              starter: {
                name: "starter",
                display_name: "Starter Plan",
                monthly_price_cents: 2000,
                yearly_price_cents: 20000,
                trial_days: 14,
                allows_region_selection: false,
              },
              standard: {
                name: "standard",
                display_name: "Pro Plan",
                monthly_price_cents: 5000,
                yearly_price_cents: 50000,
                trial_days: 14,
                allows_region_selection: true,
              },
            },
          },
        });
      }

      if (url.pathname === "/discourse_login/cli/sites" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        createPayloads.push(payload);
        if (createPayloads.length === 1) {
          assert.equal(payload.subdomain, "agent-community");
          return jsonRes(422, { errors: ["Subdomain is already taken."] });
        }
        return jsonRes(201, {
          token: "site-token-1",
          name: "Agent Community",
          subdomain: String(payload.subdomain),
          status: "in_progress",
          site_url: `https://${String(payload.subdomain)}.discourse.group`,
        });
      }

      if (url.pathname === "/discourse_login/cli/sites/site-token-1") {
        siteStatusPollCount += 1;
        if (siteStatusPollCount === 1) {
          return jsonRes(200, {
            token: "site-token-1",
            name: "Agent Community",
            subdomain: "agent-community-abcd",
            status: "in_progress",
            site_url: "https://agent-community-abcd.discourse.group",
            redirect_url: null,
          });
        }
        return jsonRes(200, {
          token: "site-token-1",
          name: "Agent Community",
          subdomain: "agent-community-1",
          status: "ready",
          site_url: "https://agent-community-1.discourse.group",
          redirect_url: "https://agent-community-1.discourse.group/invites/accept/abc",
        });
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    };

    // 1. Unauthenticated create --json exits 2 with auth_required and saves pendingAuth.
    const step1 = makeContext(["create", "--json"], { configDir, fetchImpl });
    assert.equal(await runCli(step1.ctx), 2);
    assert.equal(step1.stdout.text().includes("secret-device-code"), false);
    const out1 = JSON.parse(step1.stdout.text());
    assert.equal(out1.code, "auth_required");
    assert.equal(out1.user_code, "WXYZ-1234");
    assert.equal(step1.openedUrls.length, 0);

    // 2. Non-blocking auth poll --no-wait --json returns authorization_pending with exit 2.
    const step2 = makeContext(["auth", "poll", "--no-wait", "--json"], { configDir, fetchImpl });
    assert.equal(await runCli(step2.ctx), 2);
    const out2 = JSON.parse(step2.stdout.text());
    assert.equal(out2.code, "authorization_pending");
    assert.equal(out2.retry_after, 5);

    // 3. Blocking auth poll --json saves token without printing access_token.
    const step3 = makeContext(["auth", "poll", "--json"], { configDir, fetchImpl });
    assert.equal(await runCli(step3.ctx), 0);
    assert.equal(step3.stdout.text().includes("super-secret-bearer-token"), false);
    const out3 = JSON.parse(step3.stdout.text());
    assert.equal(out3.status, "authenticated");

    // 4. info --json reports user flags, filtered plans (without starter), and terms URLs.
    const step4 = makeContext(["info", "--json"], { configDir, fetchImpl });
    assert.equal(await runCli(step4.ctx), 0);
    const out4 = JSON.parse(step4.stdout.text());
    assert.equal(out4.provisioning_enabled, true);
    assert.equal(out4.user.age_terms_agreed, false);
    assert.equal(out4.terms_urls.free, "https://discourse.org/free-terms");
    assert.equal("starter" in out4.pricing.tiers, false);
    assert.deepEqual(
      out4.available_plans.map((p: { plan: string }) => p.plan),
      ["free", "pro"],
    );

    // 5a. Step 1: create --json with missing name & plan asks ONLY for name and plan (excluding starter).
    const step5a = makeContext(["create", "--json"], { configDir, fetchImpl });
    assert.equal(await runCli(step5a.ctx), 2);
    const out5a = JSON.parse(step5a.stdout.text());
    assert.equal(out5a.code, "missing_input");
    assert.equal(out5a.step, 1);
    assert.deepEqual(out5a.missing, ["name", "plan"]);
    assert.deepEqual(
      out5a.available_plans.map((p: { plan: string }) => p.plan),
      ["free", "pro"],
    );

    // Explicitly passing filtered-out starter plan fails with invalid_input.
    const rejectedStarter = makeContext(
      ["create", "--name", "Agent Community", "--plan", "starter", "--json"],
      { configDir, fetchImpl },
    );
    assert.equal(await runCli(rejectedStarter.ctx), 1);
    assert.equal(JSON.parse(rejectedStarter.stdout.text()).code, "invalid_input");

    // 5b. Step 2: create with name & plan returns plan-specific terms URLs.
    const step5b = makeContext(
      ["create", "--name", "Agent Community", "--plan", "pro", "--json"],
      { configDir, fetchImpl },
    );
    assert.equal(await runCli(step5b.ctx), 2);
    const out5b = JSON.parse(step5b.stdout.text());
    assert.equal(out5b.code, "terms_required");
    assert.equal(out5b.step, 2);
    assert.equal(out5b.plan, "pro");
    assert.deepEqual(out5b.missing, ["accept_terms", "accept_account_terms"]);
    assert.equal(out5b.user_terms_needed, true);
    assert.deepEqual(out5b.terms_urls, {
      hosting: "https://discourse.org/trial-terms",
      user: "https://discourse.org/user-terms",
    });

    // 6. Confirm terms without --subdomain: auto-generates subdomain, retries collision, and completes.
    const step6 = makeContext(
      [
        "create",
        "--name",
        "Agent Community",
        "--plan",
        "pro",
        "--accept-terms",
        "--accept-account-terms",
        "--json",
      ],
      { configDir, fetchImpl },
    );
    assert.equal(await runCli(step6.ctx), 0);
    assert.equal(createPayloads.length, 2);
    assert.match(String(createPayloads[1].subdomain), /^agent-community-[a-z0-9]{4}$/);
    assert.deepEqual(createPayloads[1], {
      community_name: "Agent Community",
      subdomain: createPayloads[1].subdomain,
      plan: "pro",
      legal_agreed: true,
      email_opt_in: false,
      age_terms_agreed: true,
      user_terms_agreed: true,
    });
    const out6 = JSON.parse(step6.stdout.text());
    assert.equal(out6.status, "ready");
    assert.equal("site_url" in out6, false);
    assert.equal(out6.redirect_url, "https://agent-community-1.discourse.group/invites/accept/abc");
    assert.match(out6.user_handoff, /Share ONLY redirect_url/i);
    assert.equal(out6.mcp_setup.site_setting, "mcp_server_enabled");
    assert.equal(out6.mcp_setup.user_prompt_suggestion, "now add mcp support");
    assert.equal(
      out6.mcp_setup.post_setup_note,
      "Restart your coding agents after the setup. Most agents read their skills directory and MCP configuration at startup.",
    );
    assert.match(out6.mcp_setup.agent_instructions, /now add mcp support/);
    assert.equal(
      out6.mcp_setup.agent_instructions.includes(
        "Restart your coding agents after the setup. Most agents read their skills directory and MCP configuration at startup.",
      ),
      true,
    );
    assert.match(
      out6.mcp_setup.agent_instructions,
      /https:\/\/agent-community-1\.discourse\.group\/mcp/,
    );
    assert.equal(out6.mcp_setup.detected_client.id, "generic");
    assert.equal(
      out6.mcp_setup.admin_mcp_url,
      "https://agent-community-1.discourse.group/admin/config/mcp/settings",
    );
    assert.equal(out6.mcp_setup.mcp_endpoint, "https://agent-community-1.discourse.group/mcp");
    assert.deepEqual(out6.mcp_setup.client_instructions.config_snippet, {
      name: "agent-community-1",
      transport: "http",
      url: "https://agent-community-1.discourse.group/mcp",
    });
  });

  it("supports create --no-wait followed by status <token> --wait", async (t) => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "discourse-cli-nowait-"));
    t.after(() => fs.rm(configDir, { recursive: true, force: true }));

    const store = new StateStore(configDir);
    await store.saveToken("https://id.discourse.com", {
      accessToken: "cached-tok",
      tokenType: "Bearer",
      scope: "read site_provision",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
    });

    let createdSubdomain = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/discourse_login/cli/info") {
        return jsonRes(200, {
          provisioning_enabled: true,
          user: {
            email: "a@example.com",
            username: "a",
            age_terms_agreed: true,
            user_terms_agreed: true,
            identity_setup_complete: true,
          },
          pricing: null,
        });
      }
      if (url.pathname === "/discourse_login/cli/sites" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdSubdomain = String(body.subdomain);
        return jsonRes(201, {
          token: "tok-async",
          name: "Async",
          subdomain: createdSubdomain,
          status: "in_progress",
          site_url: `https://${createdSubdomain}.discourse.group`,
        });
      }
      if (url.pathname === "/discourse_login/cli/sites/tok-async") {
        return jsonRes(200, {
          token: "tok-async",
          name: "Async",
          subdomain: "async",
          status: "ready",
          site_url: "https://async.discourse.group",
          redirect_url: "https://async.discourse.group/invites/accept/xyz",
        });
      }
      throw new Error(`Unexpected URL: ${url.toString()}`);
    };

    const createStep = makeContext(
      [
        "create",
        "--name",
        "Async",
        "--plan",
        "free",
        "--accept-terms",
        "--no-wait",
        "--json",
      ],
      { configDir, fetchImpl },
    );
    assert.equal(await runCli(createStep.ctx), 0);
    assert.equal(createdSubdomain, "async");
    const created = JSON.parse(createStep.stdout.text());
    assert.equal(created.status, "in_progress");
    assert.equal(created.token, "tok-async");

    const statusStep = makeContext(["status", "tok-async", "--wait", "--json"], {
      configDir,
      fetchImpl,
      env: { CODEX_THREAD_ID: "thread-123" },
    });
    assert.equal(await runCli(statusStep.ctx), 0);
    const ready = JSON.parse(statusStep.stdout.text());
    assert.equal(ready.status, "ready");
    assert.equal("site_url" in ready, false);
    assert.equal(ready.redirect_url, "https://async.discourse.group/invites/accept/xyz");
    assert.match(ready.user_handoff, /Share ONLY redirect_url/i);
    assert.equal(ready.mcp_setup.mcp_endpoint, "https://async.discourse.group/mcp");
    assert.equal(ready.mcp_setup.detected_client.id, "codex");
    assert.equal(
      ready.mcp_setup.client_instructions.command,
      "codex mcp add async --url https://async.discourse.group/mcp",
    );
  });

  it("handles interactive TTY two-step flow skipping subdomain and region by default", async (t) => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "discourse-cli-tty-"));
    t.after(() => fs.rm(configDir, { recursive: true, force: true }));

    const store = new StateStore(configDir);
    await store.saveToken("https://id.discourse.com", {
      accessToken: "tty-tok",
      tokenType: "Bearer",
      scope: "read site_provision",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
    });

    const textPrompts: string[] = [];
    const selectPrompts: string[] = [];
    const confirmMessages: string[] = [];
    const confirmAnswers = [true, false]; // Accept terms, decline opening admin browser at end.

    const prompter: Prompter = {
      async text({ message }) {
        textPrompts.push(message);
        return "Agent Hub";
      },
      async select({ message, choices }) {
        selectPrompts.push(message);
        return choices[0].value;
      },
      async confirm({ message }) {
        confirmMessages.push(message);
        return confirmAnswers.shift()!;
      },
    };

    let submittedPayload: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/discourse_login/cli/info") {
        return jsonRes(200, {
          provisioning_enabled: true,
          user: {
            email: "tty@example.com",
            username: "ttyuser",
            age_terms_agreed: true,
            user_terms_agreed: true,
            identity_setup_complete: true,
          },
          pricing: null,
        });
      }
      if (url.pathname === "/discourse_login/cli/sites" && init?.method === "POST") {
        submittedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonRes(201, {
          token: "tty-site",
          name: "Agent Hub",
          subdomain: "agent-hub",
          status: "in_progress",
          site_url: "https://agent-hub.discourse.group",
        });
      }
      if (url.pathname === "/discourse_login/cli/sites/tty-site") {
        return jsonRes(200, {
          token: "tty-site",
          name: "Agent Hub",
          subdomain: "agent-hub",
          status: "ready",
          site_url: "https://agent-hub.discourse.group",
          redirect_url: "https://agent-hub.discourse.group/invites/accept/tty",
        });
      }
      throw new Error(`Unexpected URL: ${url.toString()}`);
    };

    const run = makeContext(["create"], {
      configDir,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      fetchImpl,
      prompter,
    });

    assert.equal(await runCli(run.ctx), 0);
    assert.deepEqual(textPrompts, ["Community name"]);
    assert.deepEqual(selectPrompts, ["Choose a plan"]);
    assert.equal(submittedPayload?.subdomain, "agent-hub");
    assert.equal(confirmMessages[0], "Do you accept these terms?");
    const output = run.stdout.text();
    assert.match(output, /Step 1 of 2: Community details/);
    assert.match(output, /Step 2 of 2: Review terms \(Free Plan\)/);
    assert.match(output, /https:\/\/discourse\.org\/free-terms/);
    assert.doesNotMatch(output, /User Terms/);
    assert.match(output, /Admin sign-in link/);
    assert.doesNotMatch(output, /^Site URL:/m);
    assert.match(output, /mcp_server_enabled/);
    assert.match(output, /now add mcp support/);
    assert.match(output, /https:\/\/agent-hub\.discourse\.group\/mcp/);
    assert.equal(
      output.includes(
        "Restart your coding agents after the setup. Most agents read their skills directory and MCP configuration at startup.",
      ),
      true,
    );
  });

  it("prompts for custom subdomain and region with --customize and retries taken subdomain", async (t) => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "discourse-cli-customize-"));
    t.after(() => fs.rm(configDir, { recursive: true, force: true }));

    const store = new StateStore(configDir);
    await store.saveToken("https://id.discourse.com", {
      accessToken: "tty-custom-tok",
      tokenType: "Bearer",
      scope: "read site_provision",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
    });

    const textAnswers = ["Custom Club", "taken-club", "custom-club"];
    const selectAnswers = ["standard", "eu"] as const;
    const selectList = [...selectAnswers];
    const confirmAnswers = [true, false];

    const textPrompts: string[] = [];
    const selectPrompts: string[] = [];

    const prompter: Prompter = {
      async text({ message }) {
        textPrompts.push(message);
        return textAnswers.shift()!;
      },
      async select({ message }) {
        selectPrompts.push(message);
        return selectList.shift()! as never;
      },
      async confirm() {
        return confirmAnswers.shift()!;
      },
    };

    let postCount = 0;
    let finalPayload: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/discourse_login/cli/info") {
        return jsonRes(200, {
          provisioning_enabled: true,
          user: {
            email: "custom@example.com",
            username: "customuser",
            age_terms_agreed: true,
            user_terms_agreed: true,
            identity_setup_complete: true,
          },
          pricing: {
            tiers: {
              free: {
                name: "free",
                display_name: "Free Plan",
                monthly_price_cents: 0,
                yearly_price_cents: 0,
                trial_days: 0,
                allows_region_selection: false,
              },
              starter: {
                name: "starter",
                display_name: "Starter Plan",
                monthly_price_cents: 2000,
                yearly_price_cents: 20000,
                trial_days: 14,
                allows_region_selection: false,
              },
              standard: {
                name: "standard",
                display_name: "Pro Plan",
                monthly_price_cents: 5000,
                yearly_price_cents: 50000,
                trial_days: 14,
                allows_region_selection: true,
              },
            },
          },
        });
      }
      if (url.pathname === "/discourse_login/cli/sites" && init?.method === "POST") {
        postCount += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (postCount === 1) {
          assert.equal(body.subdomain, "taken-club");
          return jsonRes(422, { errors: ["Subdomain is already taken."] });
        }
        finalPayload = body;
        return jsonRes(201, {
          token: "custom-site",
          name: "Custom Club",
          subdomain: "custom-club",
          status: "in_progress",
          site_url: "https://custom-club.discourse.group",
        });
      }
      if (url.pathname === "/discourse_login/cli/sites/custom-site") {
        return jsonRes(200, {
          token: "custom-site",
          name: "Custom Club",
          subdomain: "custom-club",
          status: "ready",
          site_url: "https://custom-club.discourse.group",
          redirect_url: "https://custom-club.discourse.group/invites/accept/custom",
        });
      }
      throw new Error(`Unexpected URL: ${url.toString()}`);
    };

    const run = makeContext(["create", "--customize"], {
      configDir,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      fetchImpl,
      prompter,
    });

    assert.equal(await runCli(run.ctx), 0);
    assert.deepEqual(textPrompts, [
      "Community name",
      "Subdomain (.discourse.group)",
      "Subdomain (.discourse.group)",
    ]);
    assert.deepEqual(selectPrompts, ["Choose a plan", "Server location"]);
    assert.equal(postCount, 2);
    assert.equal(finalPayload?.plan, "standard");
    assert.equal(finalPayload?.region, "eu");
    assert.equal(finalPayload?.subdomain, "custom-club");
    const output = run.stdout.text();
    assert.match(output, /Step 2 of 2: Review terms \(Pro Plan\)/);
    assert.match(output, /https:\/\/discourse\.org\/trial-terms/);
  });

  it("returns exit 2 for explicit subdomain_taken in --json mode and exit 1 when disabled", async (t) => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "discourse-cli-errors-"));
    t.after(() => fs.rm(configDir, { recursive: true, force: true }));

    const store = new StateStore(configDir);
    await store.saveToken("https://id.discourse.com", {
      accessToken: "cached-tok",
      tokenType: "Bearer",
      scope: "read site_provision",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
    });

    const takenRun = makeContext(
      [
        "create",
        "--name",
        "Taken",
        "--plan",
        "free",
        "--subdomain",
        "taken-one",
        "--accept-terms",
        "--accept-account-terms",
        "--json",
      ],
      {
        configDir,
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname === "/discourse_login/cli/info") {
            return jsonRes(200, {
              provisioning_enabled: true,
              user: {
                email: "a@example.com",
                username: "a",
                age_terms_agreed: true,
                user_terms_agreed: true,
                identity_setup_complete: true,
              },
              pricing: null,
            });
          }
          return jsonRes(422, { errors: ["Subdomain is already taken."] });
        },
      },
    );
    assert.equal(await runCli(takenRun.ctx), 2);
    assert.equal(JSON.parse(takenRun.stdout.text()).code, "subdomain_taken");

    const disabledRun = makeContext(["create", "--json"], {
      configDir,
      fetchImpl: async () =>
        jsonRes(200, {
          provisioning_enabled: false,
          user: {
            email: "a@example.com",
            username: "a",
            age_terms_agreed: true,
            user_terms_agreed: true,
            identity_setup_complete: true,
          },
          pricing: null,
        }),
    });
    assert.equal(await runCli(disabledRun.ctx), 1);
    assert.equal(JSON.parse(disabledRun.stdout.text()).code, "provisioning_disabled");
  });

  it("clears expired or revoked cached tokens automatically on 401", async (t) => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "discourse-cli-401-"));
    t.after(() => fs.rm(configDir, { recursive: true, force: true }));

    const store = new StateStore(configDir);
    await store.saveToken("https://id.discourse.com", {
      accessToken: "revoked-tok",
      tokenType: "Bearer",
      scope: "read site_provision",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
    });

    const infoRun = makeContext(["info", "--json"], {
      configDir,
      fetchImpl: async () => jsonRes(401, { errors: ["Invalid token"] }),
    });
    assert.equal(await runCli(infoRun.ctx), 2);
    assert.equal(JSON.parse(infoRun.stdout.text()).code, "auth_required");
    assert.equal((await store.readHost("https://id.discourse.com")).token, undefined);

    await store.saveToken("https://id.discourse.com", {
      accessToken: "revoked-tok-2",
      tokenType: "Bearer",
      scope: "read site_provision",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
    });

    const authStatusRun = makeContext(["auth", "status", "--json"], {
      configDir,
      fetchImpl: async () => jsonRes(401, { errors: ["Invalid token"] }),
    });
    assert.equal(await runCli(authStatusRun.ctx), 0);
    assert.equal(JSON.parse(authStatusRun.stdout.text()).authenticated, false);
    assert.equal((await store.readHost("https://id.discourse.com")).token, undefined);
  });

  it("supports --help and --version on the built CLI binary", async () => {
    const cliPath = path.resolve(process.cwd(), "dist/cli.js");
    const helpRes = await execFileAsync(process.execPath, [cliPath, "--help"]);
    assert.match(helpRes.stdout, /discourse-create-site/);
    assert.match(helpRes.stdout, /DISCOURSE_ID_URL/);

    const pkg = JSON.parse(
      await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };
    const versionRes = await execFileAsync(process.execPath, [cliPath, "--version"]);
    assert.equal(versionRes.stdout.trim(), pkg.version);
  });
});
