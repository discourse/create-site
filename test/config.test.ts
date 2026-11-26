import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_CLIENT_IDS,
  DEFAULT_ID_URL,
  SUBDOMAIN_REGEX,
  generateCandidateSubdomain,
  normalizeIdUrl,
  normalizePlan,
  normalizeRegion,
  resolveClientId,
  resolveConfigDir,
  slugifySubdomain,
  termsUrlForPlan,
  validateCode,
  validateSubdomain,
} from "../src/config.js";

describe("config helpers", () => {
  it("normalizes Discourse ID URLs and rejects insecure remote HTTP", () => {
    assert.equal(normalizeIdUrl(), DEFAULT_ID_URL);
    assert.equal(normalizeIdUrl("https://id.discourse.com/"), "https://id.discourse.com");
    assert.equal(normalizeIdUrl("https://id.discourse.com/some/path"), "https://id.discourse.com");
    assert.equal(normalizeIdUrl("http://localhost:3000/"), "http://localhost:3000");
    assert.equal(normalizeIdUrl("http://127.0.0.1:4200"), "http://127.0.0.1:4200");

    assert.throws(() => normalizeIdUrl("http://id.discourse.com"), /https:\/\//);
    assert.throws(() => normalizeIdUrl("https://user:pass@id.discourse.com"), /credentials/);
    assert.throws(() => normalizeIdUrl("not a url"), /valid URL/);
  });

  it("resolves client IDs and config directories with expected precedence", () => {
    assert.equal(
      resolveClientId("https://id.discourse.com", "flag-uid", {
        DISCOURSE_ID_CLIENT_ID: "env-uid",
      }),
      "flag-uid",
    );
    assert.equal(
      resolveClientId("https://id.discourse.com", undefined, {
        DISCOURSE_ID_CLIENT_ID: "env-uid",
      }),
      "env-uid",
    );
    assert.equal(resolveClientId("https://unknown.example.com", undefined, {}), undefined);
    assert.equal(
      resolveClientId("https://id.discourse.com", undefined, {}),
      DEFAULT_CLIENT_IDS["https://id.discourse.com"],
    );

    assert.equal(
      resolveConfigDir("/tmp/custom-dir", { DISCOURSE_CREATE_SITE_CONFIG_DIR: "/tmp/env-dir" }),
      path.resolve("/tmp/custom-dir"),
    );
    assert.equal(
      resolveConfigDir(undefined, { XDG_CONFIG_HOME: "/tmp/xdg-home" }),
      path.resolve("/tmp/xdg-home/discourse-create-site"),
    );
  });

  it("validates subdomains matching backend rules", () => {
    assert.equal(validateSubdomain("  My-Site "), "my-site");
    assert.equal(validateSubdomain("ab"), "ab");
    assert.equal(validateSubdomain("a".repeat(49)), "a".repeat(49));
    assert.equal(SUBDOMAIN_REGEX.test("valid-123"), true);

    for (const invalid of ["a", "-start", "end-", "two.words", "a".repeat(50), "bad\nname", ""]) {
      assert.equal(validateSubdomain(invalid), undefined, `Expected "${invalid}" to be invalid`);
    }
  });

  it("slugifies community names safely into candidate subdomains", () => {
    assert.equal(slugifySubdomain("Café Developers Hub!"), "cafe-developers-hub");
    assert.equal(slugifySubdomain("  ---Hello   World--- "), "hello-world");
    assert.equal(slugifySubdomain("A"), "");
    assert.equal(slugifySubdomain("x".repeat(80)).length, 49);
  });

  it("generates valid candidate subdomains on initial and retry attempts", () => {
    assert.equal(generateCandidateSubdomain("My Community", 0), "my-community");
    assert.equal(
      generateCandidateSubdomain("My Community", 1, () => "a1b2"),
      "my-community-a1b2",
    );

    const longCandidate = generateCandidateSubdomain("x".repeat(60), 1, () => "beef");
    assert.equal(longCandidate.length, 49);
    assert.equal(longCandidate.endsWith("-beef"), true);
    assert.equal(SUBDOMAIN_REGEX.test(longCandidate), true);

    assert.equal(
      generateCandidateSubdomain("A", 0, () => "cafe"),
      "community-cafe",
    );
    assert.equal(
      generateCandidateSubdomain("🎉✨", 0, () => "1234"),
      "community-1234",
    );
  });

  it("normalizes plans, regions, codes, and terms URLs", () => {
    assert.equal(normalizePlan(" PRO "), "pro");
    assert.equal(normalizePlan("Standard"), "standard");
    assert.equal(normalizePlan("starter"), undefined);
    assert.equal(normalizePlan("enterprise"), undefined);

    assert.equal(normalizeRegion(" EUROPE "), "eu");
    assert.equal(normalizeRegion("global"), "global");
    assert.equal(normalizeRegion("us"), undefined);

    assert.equal(validateCode("PROMO_123-abc"), "PROMO_123-abc");
    assert.equal(validateCode(""), undefined);
    assert.equal(validateCode("bad/code"), undefined);
    assert.equal(validateCode("a".repeat(51)), undefined);

    assert.equal(termsUrlForPlan("free"), "https://discourse.org/free-terms");
    assert.equal(termsUrlForPlan("pro"), "https://discourse.org/trial-terms");
    assert.equal(termsUrlForPlan("business"), "https://discourse.org/trial-terms");
  });
});
