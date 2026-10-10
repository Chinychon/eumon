import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonLlm } from "@organic-growth/ai";
import { checkFixText, writeFixText, type FixText, type FixTextInput } from "./fix-text.js";

const input: FixTextInput = {
  kind: "head", siteName: "Harbour Clinic", language: "en", problems: ["title-missing", "description-missing"],
  paths: ["procedure.name", "procedure.priceFrom", "slug"], dynamic: true, queries: ["acl reconstruction cost malaysia"],
  samples: [
    { url: "https://x.com/procedures/acl", h1: "ACL Reconstruction", text: "ACL Reconstruction in Malaysia from RM 18,000 with 40 specialists. Send a WhatsApp enquiry." },
    { url: "https://x.com/procedures/mri", h1: "MRI Scan", text: "MRI Scan in Malaysia from RM 900 with 120 specialists. Send a WhatsApp enquiry." },
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

describe("checkFixText guardrails", () => {
  const bad = (patch: Partial<FixText>, inp: FixTextInput = input) => checkFixText(inp, { ...good, ...patch });
  const staticInput: FixTextInput = { ...input, dynamic: false, paths: [], problems: ["title-missing", "description-missing"] };
  const staticGood: FixText = { ...good, titleSubject: "ACL Reconstruction", description: "ACL Reconstruction in Malaysia: compare estimated costs and specialists, then send a free WhatsApp enquiry for a written quote.", examples: [{ url: "https://x.com/procedures/acl", values: [] }, { url: "https://x.com/procedures/mri", values: [] }] };

  it("accepts a grounded static route", () => assert.deepEqual(checkFixText(staticInput, staticGood), []));
  it("rejects a placeholder or a domain in a static subject", () => {
    assert.ok(checkFixText(staticInput, { ...staticGood, titleSubject: "{slug}" }).some((e) => e.includes("variables")));
    assert.ok(checkFixText(staticInput, { ...staticGood, titleSubject: "ACL Reconstruction at acme.com" }).length > 0);
  });
  it("rejects a qualifier with #1", () => assert.ok(bad({ titleQualifier: "#1 Malaysia" }).some((e) => e.startsWith("qualifier:"))));
  it("rejects {1999} and full-width digits", () => {
    assert.ok(bad({ description: good.description + " {1999}" }).length > 0);
    assert.ok(bad({ description: good.description!.replace("Malaysia", "Malaysia １９９９") }).some((e) => e.includes("digits") || e.includes("number")));
  });
  it("matches numbers as whole tokens", () => {
    const withPrice = (p: string) => bad({ description: `{procedure.name} in Malaysia from RM ${p}: compare estimated costs and specialists, then send a free WhatsApp enquiry.` });
    assert.deepEqual(withPrice("18,000").filter((e) => e.includes("number")), []);
    assert.ok(withPrice("8,000").some((e) => e.includes("8,000")));
  });
  it("rejects a domain in the description", () => assert.ok(bad({ description: good.description + " Visit acme.com" }).some((e) => e.includes("web addresses"))));
  it("matches banned words as whole tokens", () => {
    const stop = { ...input, samples: input.samples.map((s) => ({ ...s, text: s.text + " Stop by today." })) };
    assert.ok(bad({ description: good.description!.replace("compare", "top compare") }, stop).some((e) => e.includes('"top"')));
  });
  it("accepts a domain as the site name", () => assert.deepEqual(checkFixText({ ...input, siteName: "harbourclinic.my" }, good), []));
  it("allows a shared non-title value on two pages", () => {
    const shared = { ...input, paths: [...input.paths, "procedure.category"], samples: input.samples.map((s) => ({ ...s, text: s.text + " Orthopaedics." })) };
    const e = (url: string, name: string) => ({ url, values: [{ path: "procedure.name", value: name }, { path: "procedure.category", value: "Orthopaedics" }] });
    const text = { ...good, description: "{procedure.name} in Malaysia: compare {procedure.category} costs and specialists, then send a free WhatsApp enquiry for a quote.", examples: [e("https://x.com/procedures/acl", "ACL Reconstruction"), e("https://x.com/procedures/mri", "MRI Scan")] };
    assert.deepEqual(checkFixText(shared, text), []);
  });
  it("does not treat a colon as a sentence start", () => {
    assert.ok(bad({ description: good.description!.replace("compare", "Gleneagles compare") }).some((e) => e.includes("Gleneagles")));
    assert.ok(bad({ description: good.description!.replace("compare", "compare Gleneagles") }).some((e) => e.includes("Gleneagles")));
  });
  it("takes names from the site, not the search queries, outside the qualifier", () => {
    const q = { ...input, queries: [...input.queries, "gleneagles"] };
    assert.ok(checkFixText(q, { ...good, description: good.description!.replace("compare", "compare, cheaper than Gleneagles,") }).some((e) => e.includes("Gleneagles")));
  });
  it("rejects invented capitalised names", () => assert.ok(bad({ description: good.description!.replace("enquiry", "enquiry at Zenith") }).some((e) => e.includes("Zenith"))));
  it("rejects a one-character example value", () => {
    const e = bad({ examples: [{ url: "https://x.com/procedures/acl", values: [{ path: "procedure.name", value: "A" }] }, good.examples[1]!] });
    assert.ok(e.some((m) => m.includes('"A"')));
  });
  it("rejects the same value on two pages", () => {
    const e = bad({ examples: [good.examples[0]!, { url: "https://x.com/procedures/mri", values: [{ path: "procedure.name", value: "ACL Reconstruction" }] }] });
    assert.ok(e.some((m) => m.includes("same value")));
  });
});

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

  it("never throws on malformed answers or provider errors", async () => {
    const { schema: _omit, ...noSchema } = good;
    for (const answer of [{ ...noSchema, skip: false, reason: "" }, { ...good, skip: false, reason: "", examples: [{ url: "https://x.com/procedures/acl", values: [{ path: "procedure.name", value: 5 }] }] }, null, "x"]) {
      const r = await writeFixText(fakeLlm([answer]), input, { calls: 5 });
      assert.equal(r.ok, false);
      assert.ok(!r.ok && r.reason.includes("couldn't be used"));
    }
    const lenient = await writeFixText(fakeLlm([{ ...good, skip: false, reason: "" }, { supported: "false", problems: [] }]), input, { calls: 5 });
    assert.equal(lenient.ok, false);
    const throwing = { model: "fake", async json() { throw new Error("boom"); } } as unknown as JsonLlm;
    const r = await writeFixText(throwing, input, { calls: 5 });
    assert.ok(!r.ok && r.reason.includes("couldn't be used") && !r.reason.includes("boom"));
  });

  it("writes nothing without samples", async () => {
    const llm = fakeLlm([]);
    const r = await writeFixText(llm, { ...input, samples: [] }, { calls: 5 });
    assert.ok(!r.ok && r.reason.includes("No sample pages"));
    assert.equal(llm.calls, 0);
  });

  it("offers a snippet when the budget ends before the independent check", async () => {
    const r = await writeFixText(fakeLlm([{ ...good, skip: false, reason: "" }]), input, { calls: 1 });
    assert.ok(!r.ok && r.reason.includes("independently checked"));
  });

  it("does not retry for a fact error", async () => {
    const llm = fakeLlm([{ ...good, description: "{procedure.rating} in Malaysia: compare estimated costs and specialists, then send a free WhatsApp enquiry now.", skip: false, reason: "" }]);
    assert.equal((await writeFixText(llm, input, { calls: 5 })).ok, false);
    assert.equal(llm.calls, 1);
  });
});
