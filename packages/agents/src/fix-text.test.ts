import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonLlm } from "@organic-growth/ai";
import { checkFixText, writeFixText, type FixText, type FixTextInput } from "./fix-text.js";

const input: FixTextInput = {
  kind: "head", siteName: "MedBay", language: "en", problems: ["title-missing", "description-missing"],
  paths: ["procedure.name", "procedure.priceFrom", "slug"], dynamic: true, queries: ["acl reconstruction cost malaysia"],
  samples: [
    { url: "https://x.com/procedures/acl", h1: "ACL Reconstruction", text: "ACL Reconstruction in Malaysia from RM 18,000 with 40 specialists." },
    { url: "https://x.com/procedures/mri", h1: "MRI Scan", text: "MRI Scan in Malaysia from RM 900 with 120 specialists." },
  ],
};
const good: FixText = {
  facts: ["procedures are offered in Malaysia", "prices are listed in RM"],
  titleSubject: "procedure.name", titleQualifier: "Cost Malaysia",
  description: "{procedure.name} in Malaysia: compare estimated costs and specialists, then send a free WhatsApp enquiry for a written hospital quote.",
  schema: [],
  examples: [
    { url: "https://x.com/procedures/acl", values: [{ path: "procedure.name", value: "ACL Reconstruction" }] },
    { url: "https://x.com/procedures/mri", values: [{ path: "procedure.name", value: "MRI Scan" }] },
  ],
};

describe("checkFixText", () => {
  it("accepts grounded text within the budgets", () => {
    assert.deepEqual(checkFixText(input, good), []);
  });

  it("rejects unknown variables, ungrounded values, invented numbers and claims", () => {
    const errors = checkFixText(input, {
      ...good,
      description: "{procedure.rating} The best clinic in Malaysia since 1999, trusted by patients worldwide for every procedure.",
      examples: [{ url: "https://x.com/procedures/acl", values: [{ path: "procedure.name", value: "ACL Surgery" }, { path: "procedure.rating", value: "5" }] }],
    });
    assert.ok(errors.some((e) => e.includes("unknown variable procedure.rating")));
    assert.ok(errors.some((e) => e.includes("ACL Surgery")));
    assert.ok(errors.some((e) => e.includes("no example values for https://x.com/procedures/mri")));
    assert.ok(errors.some((e) => e.includes("1999")));
    assert.ok(errors.some((e) => e.includes('"best"')));
  });

  it("checks rendered lengths and the qualifier against search queries", () => {
    const errors = checkFixText(input, { ...good, titleQualifier: "Prices Packages Deals", description: "{procedure.name}." });
    assert.ok(errors.some((e) => e.startsWith("length:") && e.includes("description")));
    assert.ok(errors.some((e) => e.startsWith("qualifier:")));
  });
});

function fakeLlm(answers: unknown[]): JsonLlm & { calls: number } {
  const llm = { model: "fake", calls: 0, async json<T>() { llm.calls++; return answers.shift() as T; } };
  return llm;
}

describe("writeFixText", () => {
  it("returns checked text after a passing independent check", async () => {
    const llm = fakeLlm([{ ...good, skip: false, reason: "" }, { supported: true, problems: [] }]);
    const result = await writeFixText(llm, input, { calls: 5 });
    assert.equal(result.ok, true);
    assert.equal(llm.calls, 2);
  });

  it("retries once, naming the failure, only for length or language", async () => {
    const short = { ...good, description: "{procedure.name} in Malaysia.", skip: false, reason: "" };
    const llm = fakeLlm([short, { ...good, skip: false, reason: "" }, { supported: true, problems: [] }]);
    assert.equal((await writeFixText(llm, input, { calls: 5 })).ok, true);
    assert.equal(llm.calls, 3);
  });

  it("skips when the AI skips, the checker objects, or the budget is spent", async () => {
    assert.equal((await writeFixText(fakeLlm([{ ...good, skip: true, reason: "too little text" }]), input, { calls: 5 })).ok, false);
    assert.equal((await writeFixText(fakeLlm([{ ...good, skip: false, reason: "" }, { supported: false, problems: ["claims a price"] }]), input, { calls: 5 })).ok, false);
    assert.equal((await writeFixText(fakeLlm([]), input, { calls: 0 })).ok, false);
  });
});
