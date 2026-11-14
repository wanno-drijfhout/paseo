import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("mistral vibe usage source", () => {
  let vibeHome: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vibeHome = mkdtempSync(join(tmpdir(), "vibe-home-"));
    originalEnv = { ...process.env };
    process.env["VIBE_HOME"] = vibeHome;
    delete process.env["MISTRAL_API_KEY"];
  });
  afterEach(() => {
    rmSync(vibeHome, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  it("reports the monthly Vibe budget from the billing endpoint", async () => {
    process.env["MISTRAL_API_KEY"] = "test-key";
    const fetchApi = respond({
      vibe_budget: {
        usage_percentage: 0.35560608,
        initial_budget: 255,
        currency: "EUR",
        reset_at: "2026-12-01T00:00:00Z",
        payg_enabled: false,
      },
    });

    const report = await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, fetchApi);

    expect(fetchApi).toHaveBeenCalledWith(
      BUDGET_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
    expect(report).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({
          id: "monthly",
          summary: true,
          usedPct: 0.35560608,
          resetsAt: "2026-12-01T00:00:00Z",
        }),
      ],
      details: [{ id: "extra_usage", label: "Extra usage", value: "Disabled" }],
    });
  });

  it("marks a rejected key as unavailable", async () => {
    process.env["MISTRAL_API_KEY"] = "bad-key";

    const report = await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, respond({}, 401));

    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "vibe" },
    });
  });

  it("discovers the process env before VIBE_HOME/.env and never exposes the key", async () => {
    writeFileSync(join(vibeHome, ".env"), '# comment\nexport MISTRAL_API_KEY="dotenv-key"\n');
    const fromDotenv = await discover();
    expect(fromDotenv).toEqual([
      expect.objectContaining({
        harness: "Vibe",
        input: { store: "dotenv", locator: join(vibeHome, ".env") },
      }),
    ]);

    const fetchApi = respond({ vibe_budget: { usage_percentage: 1 } });
    await fetchUsage(fromDotenv[0]!.input as never, fetchApi);
    expect(fetchApi).toHaveBeenCalledWith(
      BUDGET_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer dotenv-key" }),
      }),
    );

    process.env["MISTRAL_API_KEY"] = "env-key";
    const fromEnv = await discover();
    expect(fromEnv[0]?.input).toEqual({ store: "env", locator: "MISTRAL_API_KEY" });
    expect(JSON.stringify([...fromDotenv, ...fromEnv])).not.toMatch(/dotenv-key|env-key/);
  });
});

describe("Mistral billing quotas", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env["MISTRAL_API_KEY"];
    process.env["MISTRAL_API_KEY"] = "synthetic-billing-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env["MISTRAL_API_KEY"];
    else process.env["MISTRAL_API_KEY"] = originalKey;
  });

  it("reports independent Vibe and API allowances without changing the Vibe window identity", async () => {
    const report = await fetchUsage(
      { store: "env", locator: "MISTRAL_API_KEY" },
      respond({
        vibe_budget: {
          usage_percentage: 3.65,
          reset_at: "2026-12-01T00:00:00Z",
          payg_enabled: false,
        },
        api_budget: { usage_percentage: 25, reset_at: "2026-12-15T00:00:00Z", payg_enabled: true },
      }),
    );

    expect(report).toEqual({
      status: "available",
      windows: [
        {
          id: "monthly",
          label: "Monthly",
          shortLabel: "mo",
          summary: true,
          usedPct: 3.65,
          remainingPct: 96.35,
          resetsAt: "2026-12-01T00:00:00Z",
          tone: "ok",
        },
        {
          id: "api_monthly",
          label: "API · Monthly",
          shortLabel: "API",
          summary: true,
          usedPct: 25,
          remainingPct: 75,
          resetsAt: "2026-12-15T00:00:00Z",
          tone: "ok",
        },
      ],
      details: [
        { id: "extra_usage", label: "Extra usage", value: "Disabled" },
        { id: "api_extra_usage", label: "API extra usage", value: "Enabled" },
      ],
    });
  });

  it("preserves Vibe-only reports and does not invent an API allowance", async () => {
    const report = await fetchUsage(
      { store: "env", locator: "MISTRAL_API_KEY" },
      respond({ vibe_budget: { usage_percentage: 0, payg_enabled: null } }),
    );
    expect(report).toEqual({
      status: "available",
      windows: [
        {
          id: "monthly",
          label: "Monthly",
          shortLabel: "mo",
          summary: true,
          usedPct: 0,
          remainingPct: 100,
          resetsAt: null,
          tone: "ok",
        },
      ],
      details: [],
    });
  });

  it("shows an API-only allowance even when no Vibe budget is present", async () => {
    const report = await fetchUsage(
      { store: "env", locator: "MISTRAL_API_KEY" },
      respond({ vibe_budget: null, api_budget: { usage_percentage: 110 } }),
    );
    expect(report).toEqual({
      status: "available",
      windows: [
        {
          id: "api_monthly",
          label: "API · Monthly",
          shortLabel: "API",
          summary: true,
          usedPct: 110,
          remainingPct: 0,
          resetsAt: null,
          tone: "danger",
        },
      ],
      details: [],
    });
  });

  it("keeps a valid API allowance visible when the Vibe allowance is malformed", async () => {
    const report = await fetchUsage(
      { store: "env", locator: "MISTRAL_API_KEY" },
      respond({ vibe_budget: { usage_percentage: "0" }, api_budget: { usage_percentage: 70 } }),
    );
    expect(report).toEqual({
      status: "available",
      windows: [
        {
          id: "api_monthly",
          label: "API · Monthly",
          shortLabel: "API",
          summary: true,
          usedPct: 70,
          remainingPct: 30,
          resetsAt: null,
          tone: "warning",
        },
      ],
      details: [
        {
          id: "monthly_invalid",
          label: "Monthly",
          value: "Usage unavailable: invalid allowance data",
        },
      ],
    });
  });

  it.each([
    {},
    { vibe_budget: null, api_budget: null },
    { vibe_budget: { usage_percentage: -1 } },
    { vibe_budget: { usage_percentage: null } },
    { api_budget: { usage_percentage: "0" } },
    { api_budget: { usage_percentage: 0, reset_at: "not-a-date" } },
  ])("reports missing or invalid quota as unavailable, never zero usage (%j)", async (budget) => {
    expect(await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, respond(budget))).toEqual(
      {
        status: "unavailable",
        problem: {
          kind: "no_quota",
          detail:
            "Mistral returned no valid Vibe or API allowance. Missing data is not zero usage.",
        },
      },
    );
  });

  it("distinguishes billing permission denial from invalid credentials", async () => {
    expect(
      await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, respond({}, 403)),
    ).toEqual({
      status: "unavailable",
      problem: {
        kind: "no_quota",
        detail:
          "Mistral denied billing access (403). The key may lack see_org_inference_usage permission.",
      },
    });
    expect(
      await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, respond({}, 401)),
    ).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "vibe" },
    });
  });

  it("reports unsupported billing endpoints and transient HTTP failures explicitly", async () => {
    expect(
      await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, respond({}, 404)),
    ).toEqual({
      status: "unavailable",
      problem: {
        kind: "no_quota",
        detail: "Mistral's billing allowance endpoint is unavailable for this account (404).",
      },
    });
    await expect(
      fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, respond({}, 429)),
    ).rejects.toThrow("Mistral billing API returned 429");
  });

  it("uses a read-only request to the fixed billing host without following redirects", async () => {
    const fetchApi = respond({ vibe_budget: { usage_percentage: 1 } });
    const report = await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, fetchApi);
    expect(fetchApi).toHaveBeenCalledWith(
      BUDGET_URL,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { Authorization: "Bearer synthetic-billing-key", Accept: "application/json" },
      }),
    );
    expect(JSON.stringify(report)).not.toContain("synthetic-billing-key");
  });
});
