import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hamming, NEAR_DUPLICATE_DISTANCE, nearDuplicate, simhash } from "./fingerprint.js";

const bio = (hospital: string, city: string, years: number) => `Dr Lim Ai Wei is a consultant obstetrician and gynaecologist at ${hospital} in ${city} with ${years} years of experience.
She completed her medical degree at the University of Malaya and her postgraduate training in obstetrics and gynaecology in Kuala Lumpur and Singapore.
Her clinical interests include high-risk pregnancy, minimally invasive gynaecological surgery, fertility assessment and menopause care.
She sees patients for antenatal care, routine screening, contraception advice and the management of fibroids and endometriosis.
Dr Lim speaks English, Malay and Mandarin, and consults on weekdays with Saturday morning sessions for returning patients.
Appointments can be made through the hospital's patient line or by WhatsApp; most insurers and company panels are accepted.
Patients describe her as thorough and reassuring, and she is known for explaining each option before a decision is made together.`;

describe("simhash", () => {
  it("is the same for the same text and within a few bits for the same page at another hospital", () => {
    const a = simhash(bio("Pantai Hospital", "Kuala Lumpur", 18));
    assert.equal(a, simhash(bio("Pantai Hospital", "Kuala Lumpur", 18)));
    assert.match(a, /^[0-9a-f]{16}$/);
    const b = simhash(bio("Gleneagles Hospital", "Penang", 20));
    assert.ok(hamming(a, b) <= NEAR_DUPLICATE_DISTANCE, `hamming ${hamming(a, b)}`);
    assert.ok(nearDuplicate(a, b));
  });

  it("is far apart for a different person with the same name, and empty for no text", () => {
    const a = simhash(bio("Pantai Hospital", "Kuala Lumpur", 18));
    const other = simhash(`Dr Lim Ai Wei is a dermatologist at Sunway Medical Centre treating acne, eczema, psoriasis and skin cancer screening.
      She trained in dermatology in Glasgow and offers laser treatments, mole checks and paediatric skin care. Clinics run Monday to Friday with same-day appointments for urgent rashes.`);
    assert.ok(hamming(a, other) > NEAR_DUPLICATE_DISTANCE * 2, `hamming ${hamming(a, other)}`);
    assert.equal(nearDuplicate(a, other), false);
    assert.equal(hamming(a, a), 0);
    assert.equal(simhash(""), "");
    assert.equal(nearDuplicate("", ""), false, "no text is not a duplicate of no text");
  });
});
