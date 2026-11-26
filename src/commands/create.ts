import {
  ApiError,
  createSite,
  getCliInfo,
  pollDeviceTokenUntilApproved,
  startDeviceAuth,
  waitForSiteReady,
  type CliInfoResponse,
  type SiteSummary,
} from "../api.js";
import {
  TERMS_URLS,
  generateCandidateSubdomain,
  normalizePlan,
  normalizeRegion,
  resolveTierName,
  slugifySubdomain,
  termsUrlForPlan,
  validateCode,
  validateSubdomain,
  type Plan,
  type Region,
} from "../config.js";
import { buildMcpSetup, formatMcpGuidance } from "../mcp.js";
import { isInteractive, writeJson } from "../output.js";
import type { Prompter } from "../prompts.js";
import type { PendingDeviceAuth } from "../store.js";
import type { CommandEnvironment } from "../types.js";
import {
  USER_HANDOFF_MESSAGE,
  emitError,
  formatTierHint,
  getEffectiveTiers,
  orderedTierEntries,
  requireClientId,
  resolveToken,
} from "./common.js";

function stringFlag(rawValues: Record<string, string | boolean | undefined>, key: string): string | undefined {
  const val = rawValues[key];
  return typeof val === "string" ? val : undefined;
}

async function authorizeInteractiveOrWait(env: CommandEnvironment, interactive: boolean): Promise<string | number> {
  const clientId = requireClientId(env);
  if (!clientId) {
    return 1;
  }

  const started = await startDeviceAuth(env.options.idUrl, clientId, {
    signup: env.options.signup,
    fetchImpl: env.ctx.fetchImpl,
  });

  const nowMs = env.ctx.now();
  const pending: PendingDeviceAuth = {
    deviceCode: started.device_code,
    userCode: started.user_code,
    verificationUri: started.verification_uri,
    verificationUriComplete: started.verification_uri_complete,
    clientId,
    interval: started.interval,
    createdAt: nowMs,
    expiresAt: nowMs + started.expires_in * 1000,
  };
  await env.store.savePendingAuth(env.options.idUrl, pending);

  env.ctx.stderr.write(
    [
      `Open this URL to authorize Discourse CLI:`,
      `  ${pending.verificationUriComplete}`,
      `Verification code: ${pending.userCode}`,
      "",
    ].join("\n"),
  );

  if ((interactive || env.options.open) && !env.options.noOpen) {
    env.ctx.openBrowser(pending.verificationUriComplete);
  }
  env.ctx.stderr.write("Waiting for browser approval...\n");

  try {
    const token = await pollDeviceTokenUntilApproved(env.options.idUrl, clientId, pending, {
      timeoutSeconds: env.options.timeoutSeconds ?? started.expires_in,
      fetchImpl: env.ctx.fetchImpl,
      sleep: env.ctx.sleep,
      now: env.ctx.now,
    });

    await env.store.saveToken(env.options.idUrl, token);
    await env.store.clearPendingAuth(env.options.idUrl);
    return token.accessToken;
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === "expired_token" ||
        error.code === "access_denied" ||
        error.code === "invalid_grant")
    ) {
      await env.store.clearPendingAuth(env.options.idUrl);
    }
    throw error;
  }
}

async function startAuthActionRequired(env: CommandEnvironment): Promise<number> {
  const clientId = requireClientId(env);
  if (!clientId) {
    return 1;
  }

  const started = await startDeviceAuth(env.options.idUrl, clientId, {
    signup: env.options.signup,
    fetchImpl: env.ctx.fetchImpl,
  });

  const nowMs = env.ctx.now();
  const pending: PendingDeviceAuth = {
    deviceCode: started.device_code,
    userCode: started.user_code,
    verificationUri: started.verification_uri,
    verificationUriComplete: started.verification_uri_complete,
    clientId,
    interval: started.interval,
    createdAt: nowMs,
    expiresAt: nowMs + started.expires_in * 1000,
  };
  await env.store.savePendingAuth(env.options.idUrl, pending);

  if (env.options.open && !env.options.noOpen) {
    env.ctx.openBrowser(pending.verificationUriComplete);
  }

  if (env.options.json) {
    writeJson(env.ctx.stdout, {
      ok: false,
      status: "action_required",
      code: "auth_required",
      id_url: env.options.idUrl,
      user_code: pending.userCode,
      verification_uri: pending.verificationUri,
      verification_uri_complete: pending.verificationUriComplete,
      expires_in: started.expires_in,
      interval: pending.interval,
      user_instructions: `Open ${pending.verificationUriComplete} and approve verification code ${pending.userCode}.`,
      next_steps: [
        "Ask the user to open verification_uri_complete and confirm the code.",
        "Run `discourse-create-site auth poll --json` to complete sign-in.",
        "Re-run `discourse-create-site create --json ...` with site parameters and terms flags.",
      ],
    });
  } else {
    env.ctx.stderr.write(
      [
        `Authentication required. Open: ${pending.verificationUriComplete}`,
        `Verification code: ${pending.userCode}`,
        "Then run: discourse-create-site auth poll",
        "",
      ].join("\n"),
    );
  }

  return 2;
}

async function authenticateAndFetchInfo(
  env: CommandEnvironment,
  interactive: boolean,
): Promise<{ accessToken: string; info: CliInfoResponse; fromCache: boolean } | number> {
  const resolved = await resolveToken(env);

  if (resolved) {
    try {
      const info = await getCliInfo(env.options.idUrl, resolved.token, {
        fetchImpl: env.ctx.fetchImpl,
      });
      return { accessToken: resolved.token, info, fromCache: resolved.fromCache };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (!resolved.fromCache) {
          return emitError(env, error, 1);
        }
        await env.store.clearToken(env.options.idUrl);
      } else {
        return emitError(env, error, 1);
      }
    }
  }

  try {
    if (!interactive && !env.options.waitForAuth) {
      return await startAuthActionRequired(env);
    }

    const tokenOrCode = await authorizeInteractiveOrWait(env, interactive);
    if (typeof tokenOrCode === "number") {
      return tokenOrCode;
    }

    const info = await getCliInfo(env.options.idUrl, tokenOrCode, {
      fetchImpl: env.ctx.fetchImpl,
    });
    return { accessToken: tokenOrCode, info, fromCache: true };
  } catch (error) {
    return emitError(env, error, 1);
  }
}

async function promptForSubdomain(
  prompter: Prompter,
  defaultSlug: string,
): Promise<string> {
  const answer = await prompter.text({
    message: "Subdomain (.discourse.group)",
    defaultValue: defaultSlug || undefined,
    validate(value) {
      if (!validateSubdomain(value)) {
        return "Subdomain must be 2-49 characters of lowercase letters, numbers, or hyphens (start/end alphanumeric).";
      }
      return undefined;
    },
  });
  return validateSubdomain(answer)!;
}

export async function runCreateCommand(env: CommandEnvironment): Promise<number> {
  const interactive = isInteractive({
    stdinIsTTY: env.ctx.stdinIsTTY,
    stdoutIsTTY: env.ctx.stdoutIsTTY,
    json: env.options.json,
    nonInteractive: env.options.nonInteractive,
  });

  // Step A & B: Authenticate and fetch preflight info.
  const authResult = await authenticateAndFetchInfo(env, interactive);
  if (typeof authResult === "number") {
    return authResult;
  }

  const { accessToken, info, fromCache } = authResult;

  if (!info.provisioning_enabled) {
    return emitError(
      env,
      new ApiError(403, "provisioning_disabled", [
        `Site provisioning is currently disabled on ${env.options.idUrl}.`,
      ]),
      1,
    );
  }

  const tiersMap = getEffectiveTiers(info.pricing);
  const needsAccountTerms = !info.user.age_terms_agreed || !info.user.user_terms_agreed;

  const rawName = stringFlag(env.rawValues, "name");
  const rawSubdomain = stringFlag(env.rawValues, "subdomain");
  const rawPlan = stringFlag(env.rawValues, "plan");
  const rawRegion = stringFlag(env.rawValues, "region");
  const rawCoupon = stringFlag(env.rawValues, "coupon-code");
  const rawReferral = stringFlag(env.rawValues, "referral-code");
  const customize = env.rawValues.customize === true;
  const acceptTerms = env.rawValues["accept-terms"] === true;
  const acceptAccountTerms = env.rawValues["accept-account-terms"] === true;
  const emailOptIn = env.rawValues["email-opt-in"] === true;

  // Validate explicitly provided flags regardless of mode.
  let communityName: string | undefined;
  if (rawName !== undefined) {
    const trimmed = rawName.trim();
    if (!trimmed || trimmed.length > 255) {
      return emitError(
        env,
        new ApiError(422, "invalid_input", [
          "Community name (--name) must contain between 1 and 255 characters.",
        ]),
        1,
      );
    }
    communityName = trimmed;
  }

  let subdomain: string | undefined;
  if (rawSubdomain !== undefined) {
    const validated = validateSubdomain(rawSubdomain);
    if (!validated) {
      return emitError(
        env,
        new ApiError(422, "invalid_input", [
          "Subdomain (--subdomain) must contain 2 to 49 lowercase letters, numbers, or hyphens and start and end with a letter or number.",
        ]),
        1,
      );
    }
    subdomain = validated;
  }

  let plan: Plan | undefined;
  if (rawPlan !== undefined) {
    const normalized = normalizePlan(rawPlan);
    if (!normalized) {
      return emitError(
        env,
        new ApiError(422, "invalid_input", [
          "Invalid --plan. Choose one of: free, pro, standard, business.",
        ]),
        1,
      );
    }
    plan = normalized;
  }

  let region: Region | undefined;
  if (rawRegion !== undefined) {
    const normalized = normalizeRegion(rawRegion);
    if (!normalized) {
      return emitError(
        env,
        new ApiError(422, "invalid_input", [
          "Invalid --region. Choose one of: global, eu.",
        ]),
        1,
      );
    }
    region = normalized;
  }

  let couponCode: string | undefined;
  if (rawCoupon !== undefined) {
    const validated = validateCode(rawCoupon);
    if (!validated) {
      return emitError(
        env,
        new ApiError(422, "invalid_input", [
          "Invalid --coupon-code. Must be 1 to 50 letters, numbers, underscores, or hyphens.",
        ]),
        1,
      );
    }
    couponCode = validated;
  }

  let referralCode: string | undefined;
  if (rawReferral !== undefined) {
    const validated = validateCode(rawReferral);
    if (!validated) {
      return emitError(
        env,
        new ApiError(422, "invalid_input", [
          "Invalid --referral-code. Must be 1 to 50 letters, numbers, underscores, or hyphens.",
        ]),
        1,
      );
    }
    referralCode = validated;
  }

  // Step C: Gather remaining inputs cleanly in two steps (never block on stdin when non-interactive).
  if (!interactive) {
    const missingStep1: string[] = [];
    if (!communityName) {
      missingStep1.push("name");
    }
    if (!plan) {
      missingStep1.push("plan");
    }

    if (missingStep1.length > 0) {
      const ordered = orderedTierEntries(tiersMap);
      const step1Flags: string[] = [
        communityName
          ? `--name ${JSON.stringify(communityName)}`
          : '--name "<community name>"',
        plan ? `--plan ${plan}` : "--plan <plan>",
      ];
      if (subdomain) {
        step1Flags.push(`--subdomain ${subdomain}`);
      }
      if (region) {
        step1Flags.push(`--region ${region}`);
      }

      if (env.options.json) {
        writeJson(env.ctx.stdout, {
          ok: false,
          status: "action_required",
          code: "missing_input",
          step: 1,
          id_url: env.options.idUrl,
          missing: missingStep1,
          available_plans: ordered.map((tier) => ({
            plan: tier.name === "standard" ? "pro" : tier.name,
            tier: tier.name,
            display_name: tier.display_name,
            trial_days: tier.trial_days,
            allows_region_selection: tier.allows_region_selection,
          })),
          message: "Step 1: Choose a community name and plan before reviewing terms.",
          next_steps: [
            "Ask the user ONLY for their community name and desired plan (subdomain is auto-generated from the name unless they request a custom one).",
            `Re-run with: ${step1Flags.join(" ")} (do not pass --accept-terms yet; Step 2 returns the exact terms URL for the chosen plan).`,
          ],
        });
      } else {
        env.ctx.stderr.write(`Step 1 — Missing required options: ${missingStep1.join(", ")}\n`);
        env.ctx.stderr.write(`Pass: ${step1Flags.join(" ")}\n`);
        env.ctx.stderr.write("Available plans:\n");
        for (const tier of ordered) {
          const hint = formatTierHint(tier);
          env.ctx.stderr.write(`  - ${tier.name} (${tier.display_name})${hint ? `: ${hint}` : ""}\n`);
        }
      }
      return 2;
    }

    const chosenPlan = plan!;
    const hostingTermsUrl = termsUrlForPlan(chosenPlan);
    const tierDisplayName = tiersMap[resolveTierName(chosenPlan)]?.display_name ?? chosenPlan;
    const missingStep2: string[] = [];
    if (!acceptTerms) {
      missingStep2.push("accept_terms");
    }
    if (needsAccountTerms && !acceptAccountTerms) {
      missingStep2.push("accept_account_terms");
    }

    if (missingStep2.length > 0) {
      const step2Flags = [`--name ${JSON.stringify(communityName!)}`, `--plan ${chosenPlan}`];
      if (subdomain) {
        step2Flags.push(`--subdomain ${subdomain}`);
      }
      if (region) {
        step2Flags.push(`--region ${region}`);
      }
      step2Flags.push("--accept-terms");
      if (needsAccountTerms) {
        step2Flags.push("--accept-account-terms");
      }

      const termsUrls = {
        hosting: hostingTermsUrl,
        ...(needsAccountTerms ? { user: TERMS_URLS.user } : {}),
      };

      if (env.options.json) {
        writeJson(env.ctx.stdout, {
          ok: false,
          status: "action_required",
          code: "terms_required",
          step: 2,
          id_url: env.options.idUrl,
          plan: chosenPlan,
          missing: missingStep2,
          user_terms_needed: needsAccountTerms,
          terms_urls: termsUrls,
          message: `Step 2: Explicit user confirmation is required for ${tierDisplayName} terms before creating the site.`,
          next_steps: [
            `Show the user the applicable terms URL(s) for ${tierDisplayName} and ask them to confirm.`,
            `Once confirmed, re-run with: ${step2Flags.join(" ")}`,
          ],
        });
      } else {
        env.ctx.stderr.write(
          `Step 2 — Explicit terms confirmation required for ${tierDisplayName}:\n`,
        );
        env.ctx.stderr.write(`  Hosting terms: ${hostingTermsUrl}\n`);
        if (needsAccountTerms) {
          env.ctx.stderr.write(`  User terms (18+): ${TERMS_URLS.user}\n`);
        }
        env.ctx.stderr.write(`Pass: ${step2Flags.join(" ")}\n`);
      }
      return 2;
    }
  }

  let prompter: Prompter | undefined;
  try {
    if (interactive) {
      prompter = env.ctx.prompterFactory();
      env.ctx.stdout.write(`Signed in as ${info.user.email || info.user.username}\n`);

      if (!communityName || !plan || (customize && (!subdomain || !region))) {
        env.ctx.stdout.write("\nStep 1 of 2: Community details\n");
      }

      if (!communityName) {
        communityName = await prompter.text({
          message: "Community name",
          validate(value) {
            if (!value || value.length > 255) {
              return "Community name must be between 1 and 255 characters.";
            }
            return undefined;
          },
        });
      }

      if (!plan) {
        const ordered = orderedTierEntries(tiersMap);
        const selected = await prompter.select({
          message: "Choose a plan",
          defaultValue: "free",
          choices: ordered.map((tier) => ({
            value: tier.name,
            label: tier.display_name,
            hint: formatTierHint(tier),
          })),
        });
        plan = normalizePlan(selected) ?? "free";
      }

      if (customize) {
        if (!subdomain) {
          subdomain = await promptForSubdomain(prompter, slugifySubdomain(communityName));
        }

        if (!region && plan !== "free") {
          const tier = tiersMap[resolveTierName(plan)];
          if (tier?.allows_region_selection) {
            region = await prompter.select<Region>({
              message: "Server location",
              defaultValue: "global",
              choices: [
                { value: "global", label: "Global" },
                { value: "eu", label: "Europe (EU)" },
              ],
            });
          }
        }
      }

      const needHostingConfirm = !acceptTerms;
      const needAccountConfirm = needsAccountTerms && !acceptAccountTerms;
      if (needHostingConfirm || needAccountConfirm) {
        const hostingUrl = termsUrlForPlan(plan);
        const tierDisplayName = tiersMap[resolveTierName(plan)]?.display_name ?? plan;
        const label =
          plan === "free" ? "Discourse Free Hosting Terms" : "Discourse Free Trial Terms";
        env.ctx.stdout.write(`\nStep 2 of 2: Review terms (${tierDisplayName})\n`);
        if (needHostingConfirm) {
          env.ctx.stdout.write(`  - ${label}: ${hostingUrl}\n`);
        }
        if (needAccountConfirm) {
          env.ctx.stdout.write(`  - Age (18+) & Discourse User Terms: ${TERMS_URLS.user}\n`);
        }

        const confirmed = await prompter.confirm({
          message: "Do you accept these terms?",
          defaultValue: false,
        });
        if (!confirmed) {
          env.ctx.stderr.write("Site creation cancelled because terms were not accepted.\n");
          return 1;
        }
      }
    }

    const finalPlan: Plan = plan ?? "free";
    const finalName = communityName!;
    const explicitSubdomain = Boolean(subdomain);
    let autoAttempt = 0;
    const MAX_AUTO_SUBDOMAIN_ATTEMPTS = 5;
    let currentSubdomain = explicitSubdomain
      ? subdomain!
      : generateCandidateSubdomain(finalName, 0);

    // Step D: Create site, auto-retrying suffixed subdomains or prompting inline when explicit.
    let created: SiteSummary;
    while (true) {
      try {
        created = await createSite(
          env.options.idUrl,
          accessToken,
          {
            community_name: finalName,
            subdomain: currentSubdomain,
            plan: finalPlan,
            ...(finalPlan !== "free" && region ? { region } : {}),
            legal_agreed: true,
            ...(needsAccountTerms ? { age_terms_agreed: true, user_terms_agreed: true } : {}),
            email_opt_in: emailOptIn,
            ...(couponCode ? { coupon_code: couponCode } : {}),
            ...(referralCode ? { referral_code: referralCode } : {}),
          },
          { fetchImpl: env.ctx.fetchImpl },
        );
        break;
      } catch (error) {
        if (error instanceof ApiError && error.code === "subdomain_taken") {
          if (!explicitSubdomain && autoAttempt < MAX_AUTO_SUBDOMAIN_ATTEMPTS - 1) {
            autoAttempt += 1;
            currentSubdomain = generateCandidateSubdomain(finalName, autoAttempt);
            continue;
          }

          if (interactive && prompter) {
            env.ctx.stderr.write(`${error.message}\n`);
            currentSubdomain = await promptForSubdomain(prompter, "");
            continue;
          }

          if (env.options.json) {
            writeJson(env.ctx.stdout, {
              ok: false,
              status: "action_required",
              code: "subdomain_taken",
              subdomain: currentSubdomain,
              message: error.message,
              errors: error.errors,
              next_steps: [
                `Choose another --subdomain (for example "${currentSubdomain}-forum") and re-run.`,
              ],
            });
          } else {
            env.ctx.stderr.write(`Subdomain "${currentSubdomain}" is already taken.\n`);
          }
          return 2;
        }

        if (error instanceof ApiError && error.status === 401 && fromCache) {
          await env.store.clearToken(env.options.idUrl);
        }
        return emitError(env, error, 1);
      }
    }

    if (env.options.noWait) {
      if (env.options.json) {
        writeJson(env.ctx.stdout, {
          ok: true,
          status: created.status,
          token: created.token,
          name: created.name,
          subdomain: created.subdomain,
          site_url: created.site_url,
          next_command: `discourse-create-site status ${created.token} --wait`,
        });
      } else {
        env.ctx.stdout.write(`Provisioning started for ${created.site_url}\n`);
        env.ctx.stdout.write(`Token: ${created.token}\n`);
        env.ctx.stdout.write(
          `Check progress with: discourse-create-site status ${created.token} --wait\n`,
        );
      }
      return 0;
    }

    // Step E: Poll until ready and print handoff + MCP setup instructions.
    let printedWaiting = false;
    const ready = await waitForSiteReady(env.options.idUrl, accessToken, created.token, {
      timeoutSeconds: env.options.timeoutSeconds ?? 300,
      fetchImpl: env.ctx.fetchImpl,
      sleep: env.ctx.sleep,
      now: env.ctx.now,
      onStatus(current) {
        if (!env.options.json && current.status !== "ready") {
          if (!printedWaiting) {
            env.ctx.stderr.write(`Provisioning ${current.site_url}`);
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

    const mcpSetup = buildMcpSetup(ready.site_url, ready.subdomain, env.ctx.env);

    if (env.options.json) {
      if (ready.redirect_url) {
        writeJson(env.ctx.stdout, {
          ok: true,
          status: "ready",
          token: ready.token,
          name: ready.name,
          subdomain: ready.subdomain,
          redirect_url: ready.redirect_url,
          user_handoff: USER_HANDOFF_MESSAGE,
          mcp_setup: mcpSetup,
        });
      } else {
        writeJson(env.ctx.stdout, {
          ok: true,
          status: "ready",
          token: ready.token,
          name: ready.name,
          subdomain: ready.subdomain,
          site_url: ready.site_url,
          redirect_url: ready.redirect_url,
          mcp_setup: mcpSetup,
        });
      }
      if (ready.redirect_url && env.options.open && !env.options.noOpen) {
        env.ctx.openBrowser(ready.redirect_url);
      }
      return 0;
    }

    env.ctx.stdout.write(`\nYour Discourse site is ready!\n`);
    if (ready.redirect_url) {
      env.ctx.stdout.write(
        `Admin sign-in link (open this directly to claim your admin account): ${ready.redirect_url}\n`,
      );
    } else {
      env.ctx.stdout.write(`Site URL: ${ready.site_url}\n`);
    }

    if (ready.redirect_url && !env.options.noOpen) {
      if (env.options.open) {
        env.ctx.openBrowser(ready.redirect_url);
      } else if (interactive && prompter) {
        const shouldOpen = await prompter.confirm({
          message: "Open admin setup in browser?",
          defaultValue: true,
        });
        if (shouldOpen) {
          env.ctx.openBrowser(ready.redirect_url);
        }
      }
    }

    env.ctx.stdout.write(`\n${formatMcpGuidance(mcpSetup)}\n`);
    return 0;
  } catch (error) {
    return emitError(env, error, 1);
  } finally {
    prompter?.close?.();
  }
}
