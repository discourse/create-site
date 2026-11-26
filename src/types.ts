import type { Writable } from "node:stream";
import type { Prompter } from "./prompts.js";
import type { StateStore } from "./store.js";

export type FetchLike = typeof globalThis.fetch;
export type SleepLike = (ms: number) => Promise<void>;
export type NowLike = () => number;
export type OpenBrowserLike = (url: string) => boolean;

export interface GlobalOptions {
  idUrl: string;
  clientId?: string;
  configDir: string;
  tokenFlag?: string;
  json: boolean;
  nonInteractive: boolean;
  open?: boolean;
  noOpen: boolean;
  wait: boolean;
  noWait: boolean;
  waitForAuth: boolean;
  signup: boolean;
  timeoutSeconds?: number;
}

export interface RunContext {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdout: Writable;
  stderr: Writable;
  fetchImpl: FetchLike;
  sleep: SleepLike;
  now: NowLike;
  openBrowser: OpenBrowserLike;
  prompterFactory: () => Prompter;
}

export interface CommandEnvironment {
  ctx: RunContext;
  store: StateStore;
  options: GlobalOptions;
  positionals: string[];
  rawValues: Record<string, string | boolean | undefined>;
}
