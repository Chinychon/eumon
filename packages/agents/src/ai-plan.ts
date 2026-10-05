import type { JsonLlm } from "@organic-growth/ai";
import { schema } from "@organic-growth/ai";
import type { Finding, GrowthPlan } from "@organic-growth/core";

const narrativeSchema = schema.object({
  situation: schema.string(),
  competitiveAdvantage: schema.string(),
  highestImpactOpportunity: schema.string(),
});

/** Adds concise synthesis while preserving the deterministic, evidence-derived priorities. */
export async function synthesizePlanNarrative(
  llm: JsonLlm,
  plan: GrowthPlan,
  findings: Finding[],
): Promise<GrowthPlan> {
  const facts = {
    site: plan.situation,
    findings: findings.slice(0, 8).map((f) => ({ id: f.id, title: f.title, summary: f.summary })),
    priorities: plan.priorities.map((p) => ({ rank: p.rank, title: p.title })),
  };
  try {
    const parsed = await llm.json<Record<string, unknown>>({
      system: "Summarize only the supplied facts for a website owner. Do not infer search demand, competitors, traffic, revenue, or causes. Keep each field under 400 characters.",
      user: JSON.stringify(facts),
      schema: narrativeSchema,
      maxTokens: 2000,
      effort: "low",
    });
    const valid = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 400;
    if (!valid(parsed.situation) || !valid(parsed.competitiveAdvantage) || !valid(parsed.highestImpactOpportunity)) return plan;
    return {
      ...plan,
      situation: parsed.situation,
      competitiveAdvantage: parsed.competitiveAdvantage,
      highestImpactOpportunity: parsed.highestImpactOpportunity,
      markdown: plan.markdown
        .replace(plan.situation, parsed.situation)
        .replace(plan.competitiveAdvantage, parsed.competitiveAdvantage)
        .replace(plan.highestImpactOpportunity, parsed.highestImpactOpportunity),
    };
  } catch {
    return plan;
  }
}
