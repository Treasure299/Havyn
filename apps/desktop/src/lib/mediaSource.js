function cleanUrl(value = "") {
  return typeof value === "string" ? value.trim() : "";
}

export function sameBrowserPage(left = "", right = "") {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.toString() === rightUrl.toString();
  } catch {
    return Boolean(left && right && left === right);
  }
}

export function sharedMediaPageUrl(source = {}) {
  return cleanUrl(source.pageUrl) ||
    cleanUrl(source.activeMediaPageUrl) ||
    cleanUrl(source.url) ||
    cleanUrl(source.activeMediaUrl) ||
    cleanUrl(source.frameUrl) ||
    cleanUrl(source.activeMediaFrameUrl);
}

export function canonicalMediaSelection(selected = {}, currentPageUrl = "") {
  // Detection is normalized against the embedded browser's actual top-level
  // page. Prefer that verified value over the live navigation signal, which a
  // cross-origin child player can briefly contaminate during frame promotion.
  const pageUrl = cleanUrl(selected.pageUrl) || cleanUrl(selected.activeMediaPageUrl) ||
    cleanUrl(currentPageUrl) || sharedMediaPageUrl(selected);
  const frameUrl = cleanUrl(selected.frameUrl) || cleanUrl(selected.activeMediaFrameUrl) ||
    cleanUrl(selected.url) || pageUrl;
  return {
    ...selected,
    // `url` remains for older room clients, but it must always mean the page
    // participants navigate to. The child player URL is only a frame locator.
    url: pageUrl,
    pageUrl,
    frameUrl
  };
}

export function isOnSharedMediaPage(currentUrl = "", source = {}) {
  const pageUrl = sharedMediaPageUrl(source);
  return Boolean(pageUrl && sameBrowserPage(currentUrl, pageUrl));
}
