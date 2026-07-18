import assert from "node:assert/strict";
import test from "node:test";
import { providerDestination } from "./contentCatalog.js";

test("uses a provider deep link when one is available", () => {
  assert.equal(providerDestination({ name: "Example", url: "https://example.com/watch/42" }, "Movie"), "https://example.com/watch/42");
});

test("builds safe provider search destinations for supported services", () => {
  assert.equal(providerDestination({ name: "Netflix" }, "The Bear & Me"), "https://www.netflix.com/search?q=The%20Bear%20%26%20Me");
  assert.match(providerDestination({ name: "Amazon Prime Video" }, "Arrival"), /^https:\/\/www\.primevideo\.com\/search/);
});

test("returns no destination for unsupported providers", () => {
  assert.equal(providerDestination({ name: "Local cinema" }, "Arrival"), "");
});
