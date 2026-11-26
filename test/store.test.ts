import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { StateStore } from "../src/store.js";

describe("StateStore", () => {
  it("persists host-isolated tokens and pending auth with 0600 permissions", async (t) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "discourse-create-site-store-"));
    const configDir = path.join(tmpDir, "config");
    t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const store = new StateStore(configDir);
    const now = 1_700_000_000_000;

    await store.saveToken("https://alt-id.example.com", {
      accessToken: "alt-secret",
      tokenType: "Bearer",
      scope: "read site_provision",
      createdAt: now,
      expiresAt: now + 3600_000,
    });

    await store.savePendingAuth("https://id.discourse.com", {
      deviceCode: "dev-123",
      userCode: "ABCD-EFGH",
      verificationUri: "https://id.discourse.com/oauth/device",
      verificationUriComplete: "https://id.discourse.com/oauth/device?user_code=ABCD-EFGH",
      clientId: "prod-client",
      interval: 5,
      createdAt: now,
      expiresAt: now + 600_000,
    });

    const stat = await fs.stat(store.statePath);
    assert.equal(stat.mode & 0o777, 0o600);

    const altToken = await store.getValidToken("https://alt-id.example.com", now);
    assert.equal(altToken?.accessToken, "alt-secret");
    assert.equal(await store.getValidToken("https://id.discourse.com", now), undefined);

    // Token within the 30s expiry buffer should be treated as expired.
    assert.equal(
      await store.getValidToken("https://alt-id.example.com", now + 3600_000 - 10_000),
      undefined,
    );

    const pending = await store.getPendingAuth("https://id.discourse.com", now + 1000);
    assert.equal(pending?.deviceCode, "dev-123");
    assert.equal(await store.getPendingAuth("https://id.discourse.com", now + 600_000), undefined);

    await store.clearHost("https://id.discourse.com");
    assert.deepEqual(await store.readHost("https://id.discourse.com"), {});
    assert.equal((await store.readHost("https://alt-id.example.com")).token?.accessToken, "alt-secret");

    await store.clearAll();
    assert.deepEqual(await store.readHost("https://alt-id.example.com"), {});
  });

  it("handles corrupt state files gracefully", async (t) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "discourse-create-site-corrupt-"));
    t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const store = new StateStore(tmpDir);
    await fs.writeFile(store.statePath, "{not valid json", "utf8");
    assert.deepEqual(await store.readHost("https://id.discourse.com"), {});
  });
});
