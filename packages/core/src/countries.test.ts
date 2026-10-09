import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COUNTRIES, countryName, countryNumeric } from "./countries.js";

describe("countries", () => {
  it("knows each market's ISO numeric code, for DataForSEO's locations", () => {
    assert.equal(countryNumeric("idn"), 360);
    assert.equal(countryNumeric("MYS"), 458);
    assert.equal(countryNumeric("xyz"), null);
    assert.ok(COUNTRIES.every((country) => Number.isInteger(country.numeric) && country.numeric > 0));
    assert.equal(countryName("sgp"), "Singapore");
  });
});
