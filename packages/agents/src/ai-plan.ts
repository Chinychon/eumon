import type { Finding, GrowthPlan } from "@organic-growth/core";

interface WorkersAI {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Adds concise synthesis while preserving the deterministic, evidence-derived priorities. */
export async function synthesizePlanNarrative(
  ai: WorkersAI,
  plan: GrowthPlan,
  findings: Finding[],
): Promise<GrowthPlan> {
  const facts = {
    site: plan.situation,
    findings: findings.slice(0, 8).map((f) => ({ id: f.id, title: f.title, summary: f.summary })),
    priorities: plan.priorities.map((p) => ({ rank: p.rank, title: p.title })),
  };
  try {
    const raw = await ai.run("@cf/google/gemma-4-26b-a4b-it", {
      messages: [
        {
          role: "system",
          content: "Summarize only the supplied facts for a website owner. Do not infer search demand, competitors, traffic, revenue, or causes. Return JSON with string fields situation, competitiveAdvantage, highestImpactOpportunity. Keep each field under 400 characters.",
        },
        { role: "user", content: JSON.stringify(facts) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 500,
    });
    const record = raw as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    const content = typeof record.response === "string"
      ? record.response
      : record.choices?.[0]?.message?.content;
    if (typeof content !== "string") return plan;
    const parsed = JSON.parse(content) as Record<string, unknown>;
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
