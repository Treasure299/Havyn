import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMediaSelection,
  isOnSharedMediaPage,
  sharedMediaPageUrl
} from "./mediaSource.js";

test("selection preserves the parent page and keeps the child player as a locator", () => {
  const selected = canonicalMediaSelection({
    url: "https://player.example/embed/42",
    pageUrl: "https://catalog.example/watch/42",
    frameUrl: "https://player.example/embed/42"
  }, "https://catalog.example/watch/42");

  assert.equal(selected.url, "https://catalog.example/watch/42");
  assert.equal(selected.pageUrl, "https://catalog.example/watch/42");
  assert.equal(selected.frameUrl, "https://player.example/embed/42");
});

test("verified parent page wins when a child player contaminates the current URL", () => {
  const selected = canonicalMediaSelection({
    url: "https://vidcore.net/movie/1339713",
    pageUrl: "https://coreflix.tv/watch/movie/1339713",
    frameUrl: "https://vidcore.net/movie/1339713"
  }, "https://vidcore.net/movie/1339713");

  assert.equal(selected.url, "https://coreflix.tv/watch/movie/1339713");
  assert.equal(selected.pageUrl, "https://coreflix.tv/watch/movie/1339713");
  assert.equal(selected.frameUrl, "https://vidcore.net/movie/1339713");
});

test("a direct player URL does not satisfy a distinct shared parent page", () => {
  const source = {
    pageUrl: "https://catalog.example/watch/42",
    frameUrl: "https://player.example/embed/42",
    url: "https://catalog.example/watch/42"
  };

  assert.equal(isOnSharedMediaPage("https://player.example/embed/42", source), false);
  assert.equal(isOnSharedMediaPage("https://catalog.example/watch/42#player", source), true);
});

test("legacy direct media remains navigable when no parent page exists", () => {
  assert.equal(sharedMediaPageUrl({ frameUrl: "https://media.example/movie.mp4" }), "https://media.example/movie.mp4");
});
