import type { JsonLlm } from "@organic-growth/ai";
import { schema } from "@organic-growth/ai";
import type { Finding, GrowthPlan } from "@organic-growth/core";

const narrativeSchema = schema.object({
  situation: schema.string(),
  competitiveAdvantage: schema.string(),
  highestImpactOpportunity: schema.string(),
});

/** Answers that say nothing; when the model gives one, the drafted text is kept. */
const NON_ANSWER = /\b(not (established|available|provided|known|determined|specified)|unknown|insufficient (data|information)|no information)\b/i;

/**
 * Rewrites the deterministic plan's headline text for a business owner while
 * keeping its facts. The evidence-derived priorities are never changed.
 */
export async function synthesizePlanNarrative(
  llm: JsonLlm,
  plan: GrowthPlan,
  findings: Finding[],
): Promise<GrowthPlan> {
  const draft = {
    situation: plan.situation,
    competitiveAdvantage: plan.competitiveAdvantage,
    highestImpactOpportunity: plan.highestImpactOpportunity,
  };
  try {
    const parsed = await llm.json<Record<string, unknown>>({
      system: "Rewrite each draft field for a website owner in plain, specific language. Keep every fact in the draft and use only the supplied facts: do not infer search demand, competitors, traffic, revenue, or causes. If you cannot improve a field, return the draft text unchanged — never answer that something is unknown or not established. Keep each field under 400 characters.",
      user: JSON.stringify({
        draft,
        findings: findings.slice(0, 8).map((f) => ({ title: f.title, summary: f.summary })),
        priorities: plan.priorities.map((p) => ({ rank: p.rank, title: p.title })),
      }),
      schema: narrativeSchema,
      maxTokens: 2000,
      effort: "low",
    });
    const pick = (field: keyof typeof draft): string => {
      const value = parsed[field];
      return typeof value === "string" && value.trim().length > 0 && value.length <= 400 && !NON_ANSWER.test(value) ? value.trim() : draft[field];
    };
    const next = { situation: pick("situation"), competitiveAdvantage: pick("competitiveAdvantage"), highestImpactOpportunity: pick("highestImpactOpportunity") };
    return {
      ...plan,
      ...next,
      markdown: plan.markdown
        .replace(plan.situation, next.situation)
        .replace(plan.competitiveAdvantage, next.competitiveAdvantage)
        .replace(plan.highestImpactOpportunity, next.highestImpactOpportunity),
    };
  } catch {
    return plan;
  }
}
