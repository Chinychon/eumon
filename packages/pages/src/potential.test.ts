import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DataRecord, Dataset, PageTemplate } from "@organic-growth/core";
import { generatePages } from "./generate.js";
import { estimatePagePotential } from "./potential.js";
import { defaultTemplate } from "./templates.js";

const dataset: Pick<Dataset, "name" | "entityType" | "fields" | "keyField" | "pageIdeas"> = {
  name: "Doctors",
  entityType: "doctor",
  keyField: "name",
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "specialty", label: "Specialty", type: "text" },
    { key: "city", label: "City", type: "text" },
    { key: "languages", label: "Languages", type: "list" },
    { key: "fee", label: "Consultation fee", type: "number" },
    { key: "bio", label: "Biography", type: "text" },
  ],
  pageIdeas: [
    { name: "Doctor profiles", groupBy: [], exampleTitle: "", exampleQueries: [], intent: "commercial", rationale: "" },
    { name: "Specialists by city", groupBy: ["specialty", "city"], exampleTitle: "", exampleQueries: [], intent: "commercial", rationale: "" },
  ],
};

const specialties = ["Cardiology", "Orthopaedics", "Oncology"];
const cities = ["Penang", "Kuala Lumpur"];
const records: DataRecord[] = Array.from({ length: 30 }, (_, index) => ({
  id: `r${index}`, siteId: "s", datasetId: "d", key: `dr-${index}`, createdAt: "", updatedAt: "",
  data: index >= 26
    // Four records with nothing but a name: too thin for their own page.
    ? { name: `Dr Thin ${index}` }
    : {
      name: `Dr ${index}`,
      specialty: specialties[index % 3]!,
      city: cities[index % 2]!,
      languages: index % 2 ? ["English", "Malay"] : ["English", "Mandarin"],
      fee: 100 + index,
      bio: `Consultant with ${10 + index} years of experience treating patients from Malaysia and Indonesia, with a focus on minimally invasive care.`,
    },
}));

describe("estimatePagePotential", () => {
  const estimates = estimatePagePotential(dataset, records);
  const byName = (name: string) => estimates.find((estimate) => estimate.name === name)!;

  it("counts publishable entity pages and holds back records without enough facts", () => {
    assert.deepEqual({ pages: byName("Doctor profiles").pages, thin: byName("Doctor profiles").thin }, { pages: 26, thin: 4 });
    const generated = generatePages({ siteId: "s", siteName: "Medbay", records, mountPath: "/guides", dataset, template: { ...defaultTemplate(dataset, dataset.pageIdeas[0]!, "/guides"), id: "t1", siteId: "s", datasetId: "d", status: "active", createdAt: "", updatedAt: "" } as PageTemplate });
    assert.equal(generated.filter((page) => page.status === "draft").length, 26, "matches what generation publishes");
  });

  it("counts grouped pages the way the generator does", () => {
    const idea = byName("Specialists by city");
    const generated = generatePages({ siteId: "s", siteName: "Medbay", records, mountPath: "/guides", dataset, template: { ...defaultTemplate(dataset, dataset.pageIdeas[1]!, "/guides"), id: "t2", siteId: "s", datasetId: "d", status: "active", createdAt: "", updatedAt: "" } as PageTemplate });
    assert.equal(idea.pages, generated.filter((page) => page.status === "draft").length);
    assert.equal(idea.pages, 6);
    assert.equal(idea.examples.length, 3);
  });

  it("suggests other groupings the data supports", () => {
    const suggested = estimates.filter((estimate) => estimate.suggested);
    // Single attributes, plus the strongest pair not already a page idea ("Mandarin-speaking cardiologists").
    assert.deepEqual(suggested.map((estimate) => estimate.groupBy.join("+")).sort(), ["city", "languages", "specialty", "specialty+languages"]);
    assert.equal(suggested.find((estimate) => estimate.groupBy[0] === "specialty")?.pages, 3);
    assert.ok(!suggested.some((estimate) => estimate.groupBy.includes("bio")), "unique free text is not a grouping");
  });
});
