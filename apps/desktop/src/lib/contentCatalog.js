const CONTENT_API_URL = String(import.meta.env?.VITE_CONTENT_API_URL || "").replace(/\/$/, "");
const TMDB_TOKEN = String(import.meta.env?.VITE_TMDB_API_TOKEN || "");
const TMDB_API_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_URL = "https://image.tmdb.org/t/p";

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value != null) query.set(key, String(value));
  });
  return query.toString();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Content request failed (${response.status})`);
  return response.json();
}

async function contentFetch(path, params = {}) {
  if (!CONTENT_API_URL) return null;
  const query = buildQuery(params);
  return fetchJson(`${CONTENT_API_URL}${path}${query ? `?${query}` : ""}`);
}

async function tmdbFetch(path, params = {}) {
  if (!TMDB_TOKEN) return null;
  const query = buildQuery(params);
  return fetchJson(`${TMDB_API_URL}${path}${query ? `?${query}` : ""}`, {
    headers: {
      Authorization: `Bearer ${TMDB_TOKEN}`,
      accept: "application/json"
    }
  });
}

function imageUrl(path, size = "w780") {
  return path ? `${TMDB_IMAGE_URL}/${size}${path}` : "";
}

function normalizeMovie(movie = {}) {
  return {
    id: Number(movie.id),
    mediaType: movie.media_type === "tv" || movie.name ? "tv" : "movie",
    title: movie.title || movie.name || "Untitled",
    originalTitle: movie.original_title || movie.original_name || "",
    overview: movie.overview || "",
    releaseDate: movie.release_date || movie.first_air_date || "",
    year: String(movie.release_date || movie.first_air_date || "").slice(0, 4),
    rating: Number(movie.vote_average || 0),
    voteCount: Number(movie.vote_count || 0),
    genreIds: movie.genre_ids || [],
    genres: movie.genres || [],
    runtime: Number(movie.runtime || movie.episode_run_time?.[0] || 0),
    certification: movie.certification || "",
    posterUrl: movie.posterUrl || imageUrl(movie.poster_path, "w500"),
    backdropUrl: movie.backdropUrl || imageUrl(movie.backdrop_path, "w1280")
  };
}

const providerSearchBuilders = [
  [/netflix/i, (title) => `https://www.netflix.com/search?q=${encodeURIComponent(title)}`],
  [/amazon|prime video/i, (title) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(title)}`],
  [/disney/i, (title) => `https://www.disneyplus.com/search?q=${encodeURIComponent(title)}`],
  [/apple tv/i, (title) => `https://tv.apple.com/search?term=${encodeURIComponent(title)}`],
  [/max|hbo/i, (title) => `https://www.max.com/search?q=${encodeURIComponent(title)}`],
  [/hulu/i, (title) => `https://www.hulu.com/search?q=${encodeURIComponent(title)}`],
  [/paramount/i, (title) => `https://www.paramountplus.com/search/?q=${encodeURIComponent(title)}`],
  [/peacock/i, (title) => `https://www.peacocktv.com/search?q=${encodeURIComponent(title)}`],
  [/youtube/i, (title) => `https://www.youtube.com/results?search_query=${encodeURIComponent(title)}`]
];

export function providerDestination(provider, movieTitle) {
  if (provider?.url) return provider.url;
  const match = providerSearchBuilders.find(([pattern]) => pattern.test(provider?.name || ""));
  return match ? match[1](movieTitle) : "";
}

export function detectContentRegion() {
  const saved = localStorage.getItem("havyn:content-region");
  if (saved) return saved.toUpperCase();
  const locale = navigator.languages?.[0] || navigator.language || "en-US";
  const region = locale.split("-")[1]?.toUpperCase();
  return region && region.length === 2 ? region : "US";
}

export async function getRecentNews({ limit = 12 } = {}) {
  const payload = await contentFetch("/api/news", { limit }).catch(() => null);
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function discoverMovies(filters = {}) {
  const params = {
    page: filters.page || 1,
    region: filters.region || detectContentRegion(),
    genre: filters.genre || "",
    year: filters.year || "",
    runtime: filters.runtime || "",
    rating: filters.rating || "",
    provider: filters.provider || "",
    query: filters.query || "",
    sort: filters.sort || "popularity.desc"
  };
  const payload = await contentFetch("/api/movies/discover", params).catch(() => null);
  if (payload?.items) return { ...payload, items: payload.items.map(normalizeMovie) };

  const endpoint = params.query ? "/search/multi" : "/discover/movie";
  const tmdbParams = params.query ? {
    query: params.query,
    include_adult: false,
    language: "en-US",
    page: params.page
  } : {
    include_adult: false,
    include_video: false,
    language: "en-US",
    page: params.page,
    region: params.region,
    sort_by: params.sort,
    with_genres: params.genre,
    primary_release_year: params.year,
    "with_runtime.lte": params.runtime,
    "vote_average.gte": params.rating,
    with_watch_providers: params.provider,
    watch_region: params.region
  };
  const direct = await tmdbFetch(endpoint, tmdbParams);
  const results = (direct?.results || []).filter((item) => item.media_type !== "person");
  return {
    page: Number(direct?.page || 1),
    totalPages: Number(direct?.total_pages || 1),
    items: results.map(normalizeMovie)
  };
}

export async function getTrendingMovies({ region = detectContentRegion(), limit = 8 } = {}) {
  const payload = await contentFetch("/api/movies/trending", { region, limit }).catch(() => null);
  if (payload?.items) return payload.items.map(normalizeMovie);
  const direct = await tmdbFetch("/trending/movie/week", { language: "en-US" });
  return (direct?.results || []).slice(0, limit).map(normalizeMovie);
}

export async function getMovieDetails(movieId, mediaType = "movie") {
  const payload = await contentFetch(`/api/movies/${mediaType}/${movieId}`).catch(() => null);
  if (payload?.item) return normalizeMovie(payload.item);
  const direct = await tmdbFetch(`/${mediaType}/${movieId}`, { language: "en-US" });
  return direct ? normalizeMovie(direct) : null;
}

export async function getMovieProviders(movieId, mediaType = "movie", region = detectContentRegion()) {
  const payload = await contentFetch(`/api/movies/${mediaType}/${movieId}/providers`, { region }).catch(() => null);
  if (payload?.providers) return payload;

  const direct = await tmdbFetch(`/${mediaType}/${movieId}/watch/providers`);
  const regional = direct?.results?.[region] || {};
  const grouped = [
    ["subscription", regional.flatrate || []],
    ["free", [...(regional.free || []), ...(regional.ads || [])]],
    ["rent", regional.rent || []],
    ["buy", regional.buy || []]
  ];
  const providers = new Map();
  grouped.forEach(([accessType, items]) => items.forEach((provider) => {
    const current = providers.get(provider.provider_id) || {
      id: provider.provider_id,
      name: provider.provider_name,
      logoUrl: imageUrl(provider.logo_path, "w185"),
      accessTypes: []
    };
    if (!current.accessTypes.includes(accessType)) current.accessTypes.push(accessType);
    providers.set(provider.provider_id, current);
  }));
  return {
    region,
    attribution: "Streaming availability data provided by JustWatch.",
    availabilityUrl: regional.link || "",
    providers: Array.from(providers.values())
  };
}

export async function getGenres() {
  const payload = await contentFetch("/api/genres").catch(() => null);
  if (payload?.items) return payload.items;
  const direct = await tmdbFetch("/genre/movie/list", { language: "en-US" });
  return direct?.genres || [];
}

export const contentCatalogConfigured = Boolean(CONTENT_API_URL || TMDB_TOKEN);

