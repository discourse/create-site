import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface StoredToken {
  accessToken: string;
  tokenType: string;
  scope: string;
  expiresAt: number;
  createdAt: number;
}

export interface PendingDeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  clientId: string;
  interval: number;
  expiresAt: number;
  createdAt: number;
}

export interface HostState {
  token?: StoredToken;
  pendingAuth?: PendingDeviceAuth;
}

export interface StoreData {
  version: 1;
  hosts: Record<string, HostState>;
}

const TOKEN_EXPIRY_BUFFER_MS = 30_000;

export class StateStore {
  readonly statePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly configDir: string) {
    this.statePath = path.join(configDir, "state.json");
  }

  async readHost(idUrl: string): Promise<HostState> {
    const data = await this.readAll();
    return data.hosts[idUrl] ?? {};
  }

  async getValidToken(idUrl: string, now = Date.now()): Promise<StoredToken | undefined> {
    const host = await this.readHost(idUrl);
    if (!host.token) {
      return undefined;
    }
    if (host.token.expiresAt <= now + TOKEN_EXPIRY_BUFFER_MS) {
      return undefined;
    }
    return host.token;
  }

  async getPendingAuth(idUrl: string, now = Date.now()): Promise<PendingDeviceAuth | undefined> {
    const host = await this.readHost(idUrl);
    if (!host.pendingAuth) {
      return undefined;
    }
    if (host.pendingAuth.expiresAt <= now) {
      return undefined;
    }
    return host.pendingAuth;
  }

  async saveToken(idUrl: string, token: StoredToken): Promise<void> {
    await this.updateHost(idUrl, (host) => ({ ...host, token }));
  }

  async clearToken(idUrl: string): Promise<void> {
    await this.updateHost(idUrl, (host) => {
      const next = { ...host };
      delete next.token;
      return next;
    });
  }

  async savePendingAuth(idUrl: string, pendingAuth: PendingDeviceAuth): Promise<void> {
    await this.updateHost(idUrl, (host) => ({ ...host, pendingAuth }));
  }

  async clearPendingAuth(idUrl: string): Promise<void> {
    await this.updateHost(idUrl, (host) => {
      const next = { ...host };
      delete next.pendingAuth;
      return next;
    });
  }

  async clearHost(idUrl: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const data = await this.readAll();
      if (!(idUrl in data.hosts)) {
        return;
      }
      delete data.hosts[idUrl];
      await this.writeAll(data);
    });
  }

  async clearAll(): Promise<void> {
    await this.enqueueWrite(async () => {
      await fs.rm(this.statePath, { force: true });
    });
  }

  private async updateHost(
    idUrl: string,
    updater: (current: HostState) => HostState,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const data = await this.readAll();
      const updated = updater(data.hosts[idUrl] ?? {});
      if (!updated.token && !updated.pendingAuth) {
        delete data.hosts[idUrl];
      } else {
        data.hosts[idUrl] = updated;
      }
      await this.writeAll(data);
    });
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async readAll(): Promise<StoreData> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      if (parsed && parsed.version === 1 && parsed.hosts && typeof parsed.hosts === "object") {
        return { version: 1, hosts: { ...parsed.hosts } };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, hosts: {} };
      }
    }
    return { version: 1, hosts: {} };
  }

  private async writeAll(data: StoreData): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.configDir, 0o700).catch(() => undefined);

    const tmpPath = path.join(
      this.configDir,
      `state.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );

    try {
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      await fs.chmod(tmpPath, 0o600).catch(() => undefined);
      await fs.rename(tmpPath, this.statePath);
      await fs.chmod(this.statePath, 0o600).catch(() => undefined);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
