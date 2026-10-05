import { schema, type JsonLlm } from "@organic-growth/ai";
import type { DataRecord, Dataset } from "@organic-growth/core";

export type DuplicateCluster = { canonicalId: string; duplicateIds: string[]; names: string[] };

/** Names per model call; sorted windows overlap so neighbouring variants always meet. */
const WINDOW = 400;
const OVERLAP = 40;

const RESOLVE_SYSTEM = `You find duplicate entries in a list of names collected from several web pages.
Group names only when they certainly refer to the same real-world entity — e.g. the same place written with or without a suffix ("Gurney Paragon" / "Gurney Paragon Mall"), with a location appended ("1st Avenue Penang"), spaced differently ("My Town" / "MyTown"), or with a number spelled out ("1 Utama" / "One Utama").
Never group different entities that merely share words (e.g. a mall and a hotel of the same developer, or two branches in different cities). When unsure, leave names separate.
For each group, choose as canonical the clearest, most complete official name from the group. Use the exact strings given; do not invent names. Return only groups with two or more names.`;

const clusterSchema = schema.object({
  groups: schema.array(schema.object({
    canonical: schema.string(),
    members: schema.array(schema.string()),
  })),
});

function nameOf(record: DataRecord, keyField: string): string {
  const value = record.data[keyField];
  return typeof value === "string" ? value : String(value ?? record.key);
}

/**
 * Asks the model which records name the same entity. Output is validated
 * strictly: every member must be an existing name, and a record joins at
 * most one cluster.
 */
export async function findDuplicateRecords(input: {
  llm: JsonLlm;
  dataset: Pick<Dataset, "name" | "entityType" | "keyField">;
  records: DataRecord[];
}): Promise<DuplicateCluster[]> {
  const byName = new Map<string, DataRecord[]>();
  for (const record of input.records) {
    const name = nameOf(record, input.dataset.keyField);
    byName.set(name, [...(byName.get(name) ?? []), record]);
  }
  const names = [...byName.keys()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }));
  if (names.length < 2) return [];

  const clusters: DuplicateCluster[] = [];
  const claimed = new Set<string>();
  for (let start = 0; start < names.length; start += WINDOW - OVERLAP) {
    const window = names.slice(start, start + WINDOW);
    const result = await input.llm.json<{ groups?: Array<{ canonical?: unknown; members?: unknown }> }>({
      system: RESOLVE_SYSTEM,
      user: JSON.stringify({ entityType: input.dataset.entityType, dataset: input.dataset.name, names: window }),
      schema: clusterSchema,
      maxTokens: 8000,
      effort: "medium",
    });
    for (const group of result.groups ?? []) {
      const members = [...new Set((Array.isArray(group.members) ? group.members : []).filter((name): name is string => typeof name === "string" && byName.has(name)))];
      const canonical = typeof group.canonical === "string" && members.includes(group.canonical) ? group.canonical : members[0];
      if (!canonical || members.length < 2 || members.some((name) => claimed.has(name))) continue;
      for (const name of members) claimed.add(name);
      const canonicalRecord = byName.get(canonical)![0]!;
      const duplicateIds = members.flatMap((name) => byName.get(name)!.map((record) => record.id)).filter((id) => id !== canonicalRecord.id);
      clusters.push({ canonicalId: canonicalRecord.id, duplicateIds, names: members });
    }
    if (start + WINDOW >= names.length) break;
  }
  return clusters;
}

/** Re-exported for callers that merge records outside the collection flow. */
export { mergeRecordData } from "@organic-growth/core";
