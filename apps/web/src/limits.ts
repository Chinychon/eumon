import { chargeUsage, getLimitOverrides, type D1Like } from "@organic-growth/db";
import type { SignalKeys } from "./results-sync.ts";

/** What a workspace may do. A null number is unlimited. */
export type Limits = {
  sites: number | null;
  analysesPerDay: number | null;
  scrapePagesPerDay: number | null;
  askPerDay: number | null;
  aiRunsPerDay: number | null;
  members: number | null;
  dataForSeo: boolean;
  pullRequests: boolean;
  sheetsExport: boolean;
};

/** Every new workspace starts here; /admin raises a workspace's limits. */
export const FREE_LIMITS: Limits = {
  sites: 1, analysesPerDay: 3, scrapePagesPerDay: 500, askPerDay: 20, aiRunsPerDay: 10, members: 3,
  dataForSeo: false, pullRequests: false, sheetsExport: false,
};

export async function limitsFor(db: D1Like, workspaceId: string): Promise<Limits> {
  return { ...FREE_LIMITS, ...(await getLimitOverrides(db, workspaceId)) as Partial<Limits> };
}

export type Metered = "analysesPerDay" | "scrapePagesPerDay" | "askPerDay" | "aiRunsPerDay";
const METERED_LABEL: Record<Metered, string> = {
  analysesPerDay: "analyses", scrapePagesPerDay: "scraped pages", askPerDay: "questions to Ask Eumon", aiRunsPerDay: "AI writing runs",
};

/** Counts `amount` against today's allowance; null when allowed, else the message to show. */
export async function charge(db: D1Like, workspaceId: string, metric: Metered, amount = 1, now = new Date()): Promise<string | null> {
  const limit = (await limitsFor(db, workspaceId))[metric];
  const ok = await chargeUsage(db, { workspaceId, day: now.toISOString().slice(0, 10), metric, amount, limit });
  return ok ? null : `Your workspace has used today's ${limit} ${METERED_LABEL[metric]}. The allowance resets at midnight UTC.`;
}

export type Feature = "dataForSeo" | "pullRequests" | "sheetsExport";
const FEATURE_LABEL: Record<Feature, string> = { dataForSeo: "keyword data", pullRequests: "pull requests", sheetsExport: "Google Sheets export" };

export async function featureRefusal(db: D1Like, workspaceId: string, feature: Feature): Promise<string | null> {
  return (await limitsFor(db, workspaceId))[feature] ? null : `This workspace's plan doesn't include ${FEATURE_LABEL[feature]} yet.`;
}

/** The sync's API keys for a workspace: DataForSEO only where the workspace may spend it. */
export function keysForLimits(keys: SignalKeys, limits: Limits): SignalKeys {
  return limits.dataForSeo ? keys : { ...keys, dataForSeo: undefined };
}
