import {
  ApiError,
  getCliInfo,
  pollDeviceTokenOnce,
  pollDeviceTokenUntilApproved,
  startDeviceAuth,
} from "../api.js";
import { isInteractive, writeJson } from "../output.js";
import type { PendingDeviceAuth, StoredToken } from "../store.js";
import type { CommandEnvironment } from "../types.js";
import { emitError, requireClientId, resolveToken } from "./common.js";

function serializeTokenSuccess(idUrl: string, token: StoredToken) {
  return {
    ok: true,
    status: "authenticated",
    id_url: idUrl,
    scope: token.scope,
    expires_at: new Date(token.expiresAt).toISOString(),
  };
}

function printDeviceInstructions(
  stream: NodeJS.WritableStream,
  pending: Pick<PendingDeviceAuth, "userCode" | "verificationUri" | "verificationUriComplete">,
): void {
  stream.write(
    [
      `Open this URL to authorize Discourse CLI:`,
      `  ${pending.verificationUriComplete}`,
      `Verification code: ${pending.userCode}`,
      `Or visit ${pending.verificationUri} and enter code ${pending.userCode}.`,
      "",
    ].join("\n"),
  );
}

async function handleAuthStart(env: CommandEnvironment): Promise<number> {
  const clientId = requireClientId(env);
  if (!clientId) {
    return 1;
  }

  try {
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
        ok: true,
        status: "pending",
        id_url: env.options.idUrl,
        user_code: pending.userCode,
        verification_uri: pending.verificationUri,
        verification_uri_complete: pending.verificationUriComplete,
        expires_in: started.expires_in,
        interval: pending.interval,
        next_command: "discourse-create-site auth poll",
      });
    } else {
      printDeviceInstructions(env.ctx.stdout, pending);
      env.ctx.stdout.write("After approving in your browser, run: discourse-create-site auth poll\n");
    }

    return 0;
  } catch (error) {
    return emitError(env, error, 1);
  }
}

async function handleAuthPoll(env: CommandEnvironment): Promise<number> {
  const hostState = await env.store.readHost(env.options.idUrl);
  const flagDeviceCode =
    typeof env.rawValues["device-code"] === "string"
      ? env.rawValues["device-code"].trim()
      : undefined;

  let pending: PendingDeviceAuth;
  let fromStore = false;

  if (flagDeviceCode) {
    const clientId = requireClientId(env);
    if (!clientId) {
      return 1;
    }
    const timeoutSeconds = env.options.timeoutSeconds ?? 600;
    pending = {
      deviceCode: flagDeviceCode,
      userCode: "",
      verificationUri: `${env.options.idUrl}/oauth/device`,
      verificationUriComplete: `${env.options.idUrl}/oauth/device`,
      clientId,
      interval: 5,
      createdAt: 0,
      expiresAt: env.ctx.now() + timeoutSeconds * 1000,
    };
  } else if (hostState.pendingAuth) {
    if (hostState.pendingAuth.expiresAt <= env.ctx.now()) {
      await env.store.clearPendingAuth(env.options.idUrl);
      return emitError(
        env,
        new ApiError(400, "expired_token", [
          "The pending device authorization code has expired. Start authentication again.",
        ]),
        1,
      );
    }
    pending = hostState.pendingAuth;
    fromStore = true;
  } else {
    return emitError(
      env,
      new ApiError(400, "no_pending_auth", [
        `No pending device authorization found for ${env.options.idUrl}. Run \`discourse-create-site auth start\` first.`,
      ]),
      1,
    );
  }

  const clientId = env.options.clientId?.trim() || pending.clientId;
  if (!clientId) {
    return emitError(
      env,
      new ApiError(400, "missing_client_id", [
        `No OAuth client_id configured for ${env.options.idUrl}. Pass --client-id <uid> or set DISCOURSE_ID_CLIENT_ID.`,
      ]),
      1,
    );
  }

  if (env.options.noWait) {
    try {
      const result = await pollDeviceTokenOnce(env.options.idUrl, clientId, pending.deviceCode, {
        fetchImpl: env.ctx.fetchImpl,
        now: env.ctx.now,
      });

      if (result.status === "approved") {
        await env.store.saveToken(env.options.idUrl, result.token);
        if (fromStore) {
          await env.store.clearPendingAuth(env.options.idUrl);
        }
        if (env.options.json) {
          writeJson(env.ctx.stdout, serializeTokenSuccess(env.options.idUrl, result.token));
        } else {
          env.ctx.stdout.write(`Authenticated with ${env.options.idUrl} (scope: ${result.token.scope}).\n`);
        }
        return 0;
      }

      if (result.status === "authorization_pending" || result.status === "slow_down") {
        const nextInterval =
          result.status === "slow_down" ? pending.interval + 5 : pending.interval;
        if (fromStore && result.status === "slow_down") {
          await env.store.savePendingAuth(env.options.idUrl, {
            ...pending,
            interval: nextInterval,
          });
        }

        if (env.options.json) {
          writeJson(env.ctx.stdout, {
            ok: false,
            status: "action_required",
            code: "authorization_pending",
            id_url: env.options.idUrl,
            retry_after: nextInterval,
            ...(pending.userCode ? { user_code: pending.userCode } : {}),
            ...(pending.userCode
              ? { verification_uri_complete: pending.verificationUriComplete }
              : {}),
            message: "Authorization is still pending user approval in the browser.",
          });
        } else {
          env.ctx.stderr.write(
            `Authorization is still pending (retry after ${nextInterval}s).\n`,
          );
        }
        return 2;
      }

      if (fromStore) {
        await env.store.clearPendingAuth(env.options.idUrl);
      }
      const message =
        result.status === "expired_token"
          ? "The device authorization code has expired. Start authentication again."
          : result.status === "access_denied"
            ? "Authorization was denied by the user."
            : result.message;
      return emitError(env, new ApiError(400, result.status, [message]), 1);
    } catch (error) {
      return emitError(env, error, 1);
    }
  }

  try {
    if (!env.options.json) {
      env.ctx.stderr.write(`Waiting for Discourse ID authorization...\n`);
    }

    const token = await pollDeviceTokenUntilApproved(env.options.idUrl, clientId, pending, {
      timeoutSeconds: env.options.timeoutSeconds ?? 600,
      fetchImpl: env.ctx.fetchImpl,
      sleep: env.ctx.sleep,
      now: env.ctx.now,
    });

    await env.store.saveToken(env.options.idUrl, token);
    if (fromStore) {
      await env.store.clearPendingAuth(env.options.idUrl);
    }

    if (env.options.json) {
      writeJson(env.ctx.stdout, serializeTokenSuccess(env.options.idUrl, token));
    } else {
      env.ctx.stdout.write(`Authenticated with ${env.options.idUrl} (scope: ${token.scope}).\n`);
    }
    return 0;
  } catch (error) {
    if (
      fromStore &&
      error instanceof ApiError &&
      (error.code === "expired_token" ||
        error.code === "access_denied" ||
        error.code === "invalid_grant")
    ) {
      await env.store.clearPendingAuth(env.options.idUrl);
    }
    return emitError(env, error, 1);
  }
}

async function handleAuthInteractive(env: CommandEnvironment): Promise<number> {
  const clientId = requireClientId(env);
  if (!clientId) {
    return 1;
  }

  const interactive = isInteractive({
    stdinIsTTY: env.ctx.stdinIsTTY,
    stdoutIsTTY: env.ctx.stdoutIsTTY,
    json: env.options.json,
    nonInteractive: env.options.nonInteractive,
  });

  try {
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

    printDeviceInstructions(env.ctx.stderr, pending);
    if ((interactive || env.options.open) && !env.options.noOpen) {
      env.ctx.openBrowser(pending.verificationUriComplete);
    }
    env.ctx.stderr.write("Waiting for browser approval...\n");

    const token = await pollDeviceTokenUntilApproved(env.options.idUrl, clientId, pending, {
      timeoutSeconds: env.options.timeoutSeconds ?? started.expires_in,
      fetchImpl: env.ctx.fetchImpl,
      sleep: env.ctx.sleep,
      now: env.ctx.now,
    });

    await env.store.saveToken(env.options.idUrl, token);
    await env.store.clearPendingAuth(env.options.idUrl);

    if (env.options.json) {
      writeJson(env.ctx.stdout, serializeTokenSuccess(env.options.idUrl, token));
    } else {
      env.ctx.stdout.write(`Authenticated with ${env.options.idUrl} (scope: ${token.scope}).\n`);
    }
    return 0;
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === "expired_token" ||
        error.code === "access_denied" ||
        error.code === "invalid_grant")
    ) {
      await env.store.clearPendingAuth(env.options.idUrl);
    }
    return emitError(env, error, 1);
  }
}

async function handleAuthStatus(env: CommandEnvironment): Promise<number> {
  const resolved = await resolveToken(env);
  if (!resolved) {
    if (env.options.json) {
      writeJson(env.ctx.stdout, {
        ok: true,
        authenticated: false,
        id_url: env.options.idUrl,
      });
    } else {
      env.ctx.stdout.write(`Not authenticated with ${env.options.idUrl}.\n`);
    }
    return 0;
  }

  try {
    const info = await getCliInfo(env.options.idUrl, resolved.token, {
      fetchImpl: env.ctx.fetchImpl,
    });

    if (env.options.json) {
      writeJson(env.ctx.stdout, {
        ok: true,
        authenticated: true,
        id_url: env.options.idUrl,
        provisioning_enabled: info.provisioning_enabled,
        user: info.user,
        ...(resolved.stored
          ? {
              scope: resolved.stored.scope,
              expires_at: new Date(resolved.stored.expiresAt).toISOString(),
            }
          : {}),
      });
    } else {
      env.ctx.stdout.write(
        `Authenticated as ${info.user.email || info.user.username} (${env.options.idUrl})\n`,
      );
      env.ctx.stdout.write(
        `Provisioning enabled: ${info.provisioning_enabled ? "yes" : "no"}\n`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      if (resolved.fromCache) {
        await env.store.clearToken(env.options.idUrl);
      }
      if (env.options.json) {
        writeJson(env.ctx.stdout, {
          ok: true,
          authenticated: false,
          id_url: env.options.idUrl,
        });
      } else {
        env.ctx.stdout.write(`Not authenticated with ${env.options.idUrl} (token expired or revoked).\n`);
      }
      return 0;
    }

    return emitError(env, error, 1);
  }
}

async function handleAuthLogout(env: CommandEnvironment): Promise<number> {
  const all = env.rawValues.all === true;
  if (all) {
    await env.store.clearAll();
  } else {
    await env.store.clearHost(env.options.idUrl);
  }

  if (env.options.json) {
    writeJson(env.ctx.stdout, {
      ok: true,
      status: "logged_out",
      ...(all ? { all: true } : { id_url: env.options.idUrl }),
    });
  } else {
    env.ctx.stdout.write(
      all
        ? "Cleared stored Discourse ID credentials for all hosts.\n"
        : `Cleared stored Discourse ID credentials for ${env.options.idUrl}.\n`,
    );
  }
  return 0;
}

export async function runAuthCommand(env: CommandEnvironment): Promise<number> {
  const subcommand = env.positionals[0];

  switch (subcommand) {
    case undefined:
      return handleAuthInteractive(env);
    case "start":
      return handleAuthStart(env);
    case "poll":
      return handleAuthPoll(env);
    case "status":
      return handleAuthStatus(env);
    case "logout":
      return handleAuthLogout(env);
    default:
      return emitError(
        env,
        new ApiError(400, "unknown_subcommand", [
          `Unknown auth subcommand "${subcommand}". Expected start, poll, status, or logout.`,
        ]),
        1,
      );
  }
}
