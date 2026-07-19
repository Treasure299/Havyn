const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMAGES = "https://image.tmdb.org/t/p";

interface Env {
  TMDB_API_TOKEN: string;
  CLIENT_ORIGIN: string;
  NEWS_FEEDS: string;
}

function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.CLIENT_ORIGIN === "*" || origin === env.CLIENT_ORIGIN ? (origin || "*") : env.CLIENT_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin"
  };
}

function json(request: Request, env: Env, value: unknown, status = 200, maxAge = 900) {
  return Response.json(value, {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`
    }
  });
}

async function tmdb(path: string, params: URLSearchParams, env: Env) {
  const url = new URL(`${TMDB_API}${path}`);
  params.forEach((value, key) => {
    if (value) url.searchParams.set(key, value);
  });
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.TMDB_API_TOKEN}`, accept: "application/json" },
    cf: { cacheEverything: true, cacheTtl: 900 }
  });
  if (!response.ok) throw new Error(`TMDB returned ${response.status}`);
  return response.json<Record<string, unknown>>();
}

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => {
      const value = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function element(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return decodeXml(match?.[1] || "");
}

function attribute(item: string, tag: string, name: string) {
  const match = item.match(new RegExp(`<${tag}[^>]*\\s${name}=["']([^"']+)["'][^>]*>`, "i"));
  return decodeXml(match?.[1] || "");
}

function newsCategory(title: string) {
  if (/cast|casting|joins|stars|role/i.test(title)) return "Casting";
  if (/trailer|teaser|first look/i.test(title)) return "Trailers";
  if (/release|premiere|box office|opens/i.test(title)) return "Releases";
  return "Industry";
}

async function readFeed(feedUrl: string) {
  const response = await fetch(feedUrl, { headers: { "User-Agent": "Havyn/1.0 (+https://havyn.app)" }, cf: { cacheEverything: true, cacheTtl: 900 } });
  if (!response.ok) return [];
  const xml = await response.text();
  const source = element(xml, "title") || new URL(feedUrl).hostname.replace(/^www\./, "");
  return Array.from(xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)).slice(0, 10).map((match) => {
    const item = match[1];
    const title = element(item, "title");
    const url = element(item, "link") || element(item, "guid");
    const publishedAt = element(item, "pubDate") || element(item, "dc:date");
    const imageUrl = attribute(item, "media:content", "url") || attribute(item, "media:thumbnail", "url") || attribute(item, "enclosure", "url");
    return {
      id: url || crypto.randomUUID(),
      title,
      url,
      source,
      summary: element(item, "description").slice(0, 240),
      category: newsCategory(title),
      imageUrl,
      publishedAt,
      publishedLabel: publishedAt ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.max(-30, Math.round((new Date(publishedAt).getTime() - Date.now()) / 86400000)), "day") : "Recently"
    };
  }).filter((item) => item.title && item.url);
}

async function news(request: Request, env: Env, url: URL) {
  const feeds = String(env.NEWS_FEEDS || "").split(",").map((item) => item.trim()).filter(Boolean);
  const settled = await Promise.allSettled(feeds.map(readFeed));
  const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 12)));
  const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
    .slice(0, limit);
  return json(request, env, { items }, 200, 600);
}

function providerLogo(path: unknown) {
  return path ? `${TMDB_IMAGES}/w185${String(path)}` : "";
}

async function providers(request: Request, env: Env, url: URL, mediaType: string, id: string) {
  const payload = await tmdb(`/${mediaType}/${id}/watch/providers`, new URLSearchParams(), env);
  const results = payload.results as Record<string, Record<string, unknown>> | undefined;
  const region = String(url.searchParams.get("region") || "US").toUpperCase();
  const regional = results?.[region] || {};
  const groups: Array<[string, Array<Record<string, unknown>>]> = [
    ["subscription", (regional.flatrate as Array<Record<string, unknown>>) || []],
    ["free", [...((regional.free as Array<Record<string, unknown>>) || []), ...((regional.ads as Array<Record<string, unknown>>) || [])]],
    ["rent", (regional.rent as Array<Record<string, unknown>>) || []],
    ["buy", (regional.buy as Array<Record<string, unknown>>) || []]
  ];
  const merged = new Map<number, { id: number; name: string; logoUrl: string; accessTypes: string[] }>();
  groups.forEach(([accessType, entries]) => entries.forEach((entry) => {
    const providerId = Number(entry.provider_id);
    const current = merged.get(providerId) || { id: providerId, name: String(entry.provider_name || "Provider"), logoUrl: providerLogo(entry.logo_path), accessTypes: [] };
    if (!current.accessTypes.includes(accessType)) current.accessTypes.push(accessType);
    merged.set(providerId, current);
  }));
  return json(request, env, { region, attribution: "Streaming availability data provided by JustWatch.", availabilityUrl: regional.link || "", providers: [...merged.values()] });
}

async function handle(request: Request, env: Env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (request.method !== "GET") return json(request, env, { error: "Method not allowed" }, 405, 0);
  if (url.pathname === "/health") return json(request, env, { ok: true }, 200, 30);
  if (url.pathname === "/api/news") return news(request, env, url);
  if (url.pathname === "/api/genres") {
    const payload = await tmdb("/genre/movie/list", new URLSearchParams({ language: "en-US" }), env);
    return json(request, env, { items: payload.genres || [] }, 200, 86400);
  }
  if (url.pathname === "/api/movies/trending") {
    const payload = await tmdb("/trending/movie/week", new URLSearchParams({ language: "en-US" }), env);
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 8)));
    return json(request, env, { items: ((payload.results as unknown[]) || []).slice(0, limit) });
  }
  if (url.pathname === "/api/movies/discover") {
    const query = url.searchParams.get("query");
    const path = query ? "/search/multi" : "/discover/movie";
    const params = new URLSearchParams({ language: "en-US", include_adult: "false", page: url.searchParams.get("page") || "1" });
    if (query) params.set("query", query);
    else {
      params.set("sort_by", url.searchParams.get("sort") || "popularity.desc");
      params.set("region", url.searchParams.get("region") || "US");
      for (const [source, target] of [["genre", "with_genres"], ["year", "primary_release_year"], ["runtime", "with_runtime.lte"], ["rating", "vote_average.gte"], ["provider", "with_watch_providers"]]) {
        const value = url.searchParams.get(source);
        if (value) params.set(target, value);
      }
      if (url.searchParams.get("provider")) params.set("watch_region", url.searchParams.get("region") || "US");
    }
    const payload = await tmdb(path, params, env);
    return json(request, env, { page: payload.page || 1, totalPages: payload.total_pages || 1, items: payload.results || [] });
  }
  const match = url.pathname.match(/^\/api\/movies\/(movie|tv)\/(\d+)(\/providers)?$/);
  if (match?.[3]) return providers(request, env, url, match[1], match[2]);
  if (match) {
    const payload = await tmdb(`/${match[1]}/${match[2]}`, new URLSearchParams({ language: "en-US" }), env);
    return json(request, env, { item: payload });
  }
  return json(request, env, { error: "Not found" }, 404, 0);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "content-request-failed", path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) }));
      return json(request, env, { error: "Content is temporarily unavailable" }, 502, 30);
    }
  }
} satisfies ExportedHandler<Env>;
