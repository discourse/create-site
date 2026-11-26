import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { ApiError } from "./api.js";
import { openBrowser } from "./browser.js";
import { runAuthCommand } from "./commands/auth.js";
import { runCreateCommand } from "./commands/create.js";
import { runInfoCommand } from "./commands/info.js";
import { runStatusCommand } from "./commands/status.js";
import {
  DEFAULT_ID_URL,
  normalizeIdUrl,
  resolveClientId,
  resolveConfigDir,
} from "./config.js";
import { formatCliError, writeJson } from "./output.js";
import { createReadlinePrompter } from "./prompts.js";
import { StateStore } from "./store.js";
import type { CommandEnvironment, GlobalOptions, RunContext } from "./types.js";

const HELP_TEXT = `Usage:
  discourse-create-site [create] [options]
  discourse-create-site auth [start|poll|status|logout] [options]
  discourse-create-site info [options]
  discourse-create-site status <token> [options]

Commands:
  create                 Provision a hosted Discourse site (default command)
  auth                   Run interactive Discourse ID device login and wait
  auth start             Start device authorization and return URL/code without blocking
  auth poll              Poll device authorization for completion (--no-wait for single check)
  auth status            Check current Discourse ID session validity
  auth logout            Remove stored local credentials (--all for every host)
  info                   Show authenticated user status, terms status, and plans
  status <token>         Check or wait (--wait) for site provisioning readiness

Global options:
  --id-url <url>         Discourse ID base URL (default: ${DEFAULT_ID_URL}, env: DISCOURSE_ID_URL)
  --client-id <uid>      OAuth client_id (built-in default for ${DEFAULT_ID_URL}, env: DISCOURSE_ID_CLIENT_ID)
  --config-dir <path>    Credential directory (env: DISCOURSE_CREATE_SITE_CONFIG_DIR)
  --token <token>        Explicit Bearer access token (env: DISCOURSE_ID_TOKEN)
  --json                 Machine-readable JSON output; never prompts on stdin
  --non-interactive      Never prompt on stdin
  --open / --no-open     Control browser opening
  --wait / --no-wait     Control polling behavior
  --wait-for-auth        Block waiting for browser device login even in --json/--non-interactive
  --signup               Add intent=signup to device verification URL
  --timeout <seconds>    Override wait timeout (auth/site polling)
  -h, --help             Show this help message
  -v, --version          Show package version

Create options:
  --name <name>          Step 1: Community name (1-255 chars)
  --plan <plan>          Step 1: free | pro | standard | business
  --accept-terms         Step 2: Confirm Discourse Free/Trial Hosting Terms for chosen plan
  --accept-account-terms Step 2: Confirm 18+ age and Discourse User Terms (if not already agreed)
  --customize            Prompt interactively for custom subdomain and server region (TTY mode)
  --subdomain <slug>     Override auto-generated subdomain for <slug>.discourse.group
  --region <region>      Override server region (global | eu | europe)
  --email-opt-in         Opt in to Discourse product updates
  --coupon-code <code>   Optional coupon code (paid plans)
  --referral-code <code> Optional referral code (paid plans)

Auth options:
  --device-code <code>   Explicit device_code for \`auth poll\`
  --all                  Clear all hosts for \`auth logout\`

Exit codes:
  0  Success
  1  Error (invalid input, disabled provisioning, network/API failure)
  2  Action required from end user (auth_required, authorization_pending, missing_input, terms_required, subdomain_taken)
`;

async function readPackageVersion(): Promise<string> {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const raw = await fs.readFile(new URL(rel, import.meta.url), "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string" && parsed.version) {
        return parsed.version;
      }
    } catch {
      // Check next relative location.
    }
  }
  return "0.1.0";
}

export function createDefaultContext(argv: string[]): RunContext {
  return {
    argv,
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdout: process.stdout,
    stderr: process.stderr,
    fetchImpl: globalThis.fetch,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    openBrowser,
    prompterFactory: () => createReadlinePrompter(process.stdin, process.stderr),
  };
}

function writeCliFailure(ctx: RunContext, json: boolean, error: unknown): number {
  const formatted = formatCliError(error);
  if (json) {
    writeJson(ctx.stdout, {
      ok: false,
      status: "error",
      code: formatted.code,
      message: formatted.message,
      errors: formatted.errors,
    });
  } else {
    ctx.stderr.write(`Error (${formatted.code}): ${formatted.message}\n`);
  }
  return 1;
}

export async function runCli(ctx: RunContext): Promise<number> {
  const wantsJsonHint = ctx.argv.includes("--json");

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      strict: true,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        json: { type: "boolean" },
        "non-interactive": { type: "boolean" },
        "id-url": { type: "string" },
        "client-id": { type: "string" },
        "config-dir": { type: "string" },
        token: { type: "string" },
        open: { type: "boolean" },
        "no-open": { type: "boolean" },
        wait: { type: "boolean" },
        "no-wait": { type: "boolean" },
        "wait-for-auth": { type: "boolean" },
        signup: { type: "boolean" },
        timeout: { type: "string" },
        "device-code": { type: "string" },
        all: { type: "boolean" },
        name: { type: "string" },
        subdomain: { type: "string" },
        plan: { type: "string" },
        region: { type: "string" },
        customize: { type: "boolean" },
        "accept-terms": { type: "boolean" },
        "accept-account-terms": { type: "boolean" },
        "email-opt-in": { type: "boolean" },
        "coupon-code": { type: "string" },
        "referral-code": { type: "string" },
      },
    });
  } catch (error) {
    return writeCliFailure(
      ctx,
      wantsJsonHint,
      new ApiError(400, "invalid_arguments", [
        error instanceof Error ? error.message : String(error),
      ]),
    );
  }

  const values = parsed.values as Record<string, string | boolean | undefined>;
  const json = values.json === true;

  if (values.help === true) {
    ctx.stdout.write(HELP_TEXT);
    return 0;
  }

  if (values.version === true) {
    const version = await readPackageVersion();
    ctx.stdout.write(`${version}\n`);
    return 0;
  }

  if (values.open === true && values["no-open"] === true) {
    return writeCliFailure(
      ctx,
      json,
      new ApiError(400, "invalid_arguments", ["Cannot combine --open and --no-open."]),
    );
  }

  if (values.wait === true && values["no-wait"] === true) {
    return writeCliFailure(
      ctx,
      json,
      new ApiError(400, "invalid_arguments", ["Cannot combine --wait and --no-wait."]),
    );
  }

  let timeoutSeconds: number | undefined;
  if (typeof values.timeout === "string") {
    const num = Number(values.timeout);
    if (!Number.isFinite(num) || num <= 0) {
      return writeCliFailure(
        ctx,
        json,
        new ApiError(400, "invalid_arguments", ["--timeout must be a positive number of seconds."]),
      );
    }
    timeoutSeconds = num;
  }

  let idUrl: string;
  try {
    const rawUrl =
      typeof values["id-url"] === "string" ? values["id-url"] : ctx.env.DISCOURSE_ID_URL;
    idUrl = normalizeIdUrl(rawUrl);
  } catch (error) {
    return writeCliFailure(
      ctx,
      json,
      new ApiError(400, "invalid_id_url", [
        error instanceof Error ? error.message : String(error),
      ]),
    );
  }

  const clientId = resolveClientId(
    idUrl,
    typeof values["client-id"] === "string" ? values["client-id"] : undefined,
    ctx.env,
  );
  const configDir = resolveConfigDir(
    typeof values["config-dir"] === "string" ? values["config-dir"] : undefined,
    ctx.env,
  );

  const options: GlobalOptions = {
    idUrl,
    clientId,
    configDir,
    tokenFlag: typeof values.token === "string" ? values.token : undefined,
    json,
    nonInteractive: values["non-interactive"] === true,
    open: values.open === true ? true : undefined,
    noOpen: values["no-open"] === true,
    wait: values.wait === true,
    noWait: values["no-wait"] === true,
    waitForAuth: values["wait-for-auth"] === true,
    signup: values.signup === true,
    timeoutSeconds,
  };

  const store = new StateStore(configDir);
  const [firstPositional, ...restPositionals] = parsed.positionals;

  const baseEnv: CommandEnvironment = {
    ctx,
    store,
    options,
    positionals: parsed.positionals,
    rawValues: values,
  };

  switch (firstPositional) {
    case undefined:
      return runCreateCommand(baseEnv);
    case "create":
      return runCreateCommand({ ...baseEnv, positionals: restPositionals });
    case "auth":
      return runAuthCommand({ ...baseEnv, positionals: restPositionals });
    case "info":
      return runInfoCommand({ ...baseEnv, positionals: restPositionals });
    case "status":
      return runStatusCommand({ ...baseEnv, positionals: restPositionals });
    default:
      return writeCliFailure(
        ctx,
        json,
        new ApiError(400, "unknown_command", [
          `Unknown command "${firstPositional}". Run with --help to see available commands.`,
        ]),
      );
  }
}
