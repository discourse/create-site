import type { Writable } from "node:stream";
import type { ApiError } from "./api.js";

export function writeJson(stream: Writable, payload: unknown): void {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function isInteractive(options: {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  json: boolean;
  nonInteractive: boolean;
}): boolean {
  return options.stdinIsTTY && options.stdoutIsTTY && !options.json && !options.nonInteractive;
}

export function formatCliError(error: unknown): {
  code: string;
  message: string;
  errors: string[];
  status?: number;
  retryAfterSeconds?: number;
} {
  if (error instanceof Error && "code" in error && "status" in error && "errors" in error) {
    const apiErr = error as ApiError;
    return {
      code: apiErr.code,
      message: apiErr.message,
      errors: apiErr.errors,
      status: apiErr.status,
      ...(apiErr.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: apiErr.retryAfterSeconds }
        : {}),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "error",
    message,
    errors: [message],
  };
}
