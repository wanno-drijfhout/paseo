import type { UsageInput } from "../shared/input.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageDetail,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const execFileAsync = promisify(execFile);

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";
const API_KEY_ENV = "MISTRAL_API_KEY";
// Vibe stores its login under this service, with the env var name as the account.
const KEYCHAIN_SERVICE = "ai.mistral.vibe";
const KEYCHAIN_TIMEOUT_MS = 2_000;

const BudgetSchema = z.object({
  usage_percentage: z.number().finite().nonnegative(),
  reset_at: z.string().datetime({ offset: true }).nullish(),
  payg_enabled: z.boolean().nullish(),
});
const BudgetResponseSchema = z.object({
  vibe_budget: z.unknown().optional(),
  api_budget: z.unknown().optional(),
});

const BUDGETS = [
  {
    field: "vibe_budget",
    id: "monthly",
    label: "Monthly",
    shortLabel: "mo",
    extraId: "extra_usage",
    extraLabel: "Extra usage",
  },
  {
    field: "api_budget",
    id: "api_monthly",
    label: "API · Monthly",
    shortLabel: "API",
    extraId: "api_extra_usage",
    extraLabel: "API extra usage",
  },
] as const;

function vibeHome(): string {
  return process.env["VIBE_HOME"] || join(homedir(), ".vibe");
}

function parseDotenvValue(content: string, name: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== name) continue;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    return value || undefined;
  }
  return undefined;
}

async function readApiKey(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator] || undefined;
  if (input.store === "dotenv") {
    try {
      return parseDotenvValue(await fs.readFile(input.locator, "utf8"), API_KEY_ENV);
    } catch {
      return undefined;
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-a", API_KEY_ENV, "-w", "-s", input.locator],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const apiKey = await readApiKey(input);
  if (!apiKey) throw new Error("Mistral Vibe login store no longer exists");

  const res = await fetchApi(BUDGET_URL, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 401) {
    return unavailable({ kind: "rejected", status: res.status, refreshedBy: "vibe" });
  }
  if (res.status === 403) {
    return unavailable({
      kind: "no_quota",
      detail:
        "Mistral denied billing access (403). The key may lack see_org_inference_usage permission.",
    });
  }
  if (res.status === 404) {
    return unavailable({
      kind: "no_quota",
      detail: "Mistral's billing allowance endpoint is unavailable for this account (404).",
    });
  }
  if (!res.ok) throw new Error(`Mistral billing API returned ${res.status}`);

  const response = BudgetResponseSchema.safeParse(await res.json());
  if (!response.success) throw new Error("Mistral returned an invalid billing response");
  const windows: UsageWindow[] = [];
  const details: UsageDetail[] = [];
  // Vibe's billing contract describes monthly allowances. Preserve the original
  // Vibe window ID so saved pins continue to identify the same quota.
  // https://github.com/mistralai/mistral-vibe/blob/main/vibe/app_server/_billing.py
  for (const spec of BUDGETS) {
    const raw = response.data[spec.field];
    if (raw == null) continue;
    const budget = BudgetSchema.safeParse(raw);
    if (!budget.success) {
      details.push({
        id: `${spec.id}_invalid`,
        label: spec.label,
        value: "Usage unavailable: invalid allowance data",
      });
      continue;
    }
    const allowance = budget.data;
    windows.push(
      windowFromUsedPct({
        id: spec.id,
        label: spec.label,
        shortLabel: spec.shortLabel,
        summary: true,
        utilizationPct: allowance.usage_percentage,
        resetsAt: allowance.reset_at,
        tone: toneFromUsedPct(allowance.usage_percentage),
      }),
    );
    if (allowance.payg_enabled != null) {
      const value = allowance.payg_enabled ? "Enabled" : "Disabled";
      details.push({ id: spec.extraId, label: spec.extraLabel, value });
    }
  }
  if (windows.length === 0)
    return unavailable({
      kind: "no_quota",
      detail: "Mistral returned no valid Vibe or API allowance. Missing data is not zero usage.",
    });
  return { status: "available", windows, details };
}

/** Same precedence as Vibe: process env, then `$VIBE_HOME/.env`, then the macOS Keychain. */
export async function discover(): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = [
    { store: "env", locator: API_KEY_ENV },
    { store: "dotenv", locator: join(vibeHome(), ".env") },
  ];
  if (process.platform === "darwin") {
    candidates.push({ store: "keychain", locator: KEYCHAIN_SERVICE });
  }
  for (const input of candidates) {
    if (await readApiKey(input)) {
      return [
        {
          key: hashAccountKey(`mistral-vibe:${input.store}:${input.locator}`),
          harness: "Vibe",
          input,
        },
      ];
    }
  }
  return [];
}
