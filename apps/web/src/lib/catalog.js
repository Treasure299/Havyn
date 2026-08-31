const CONTENT_API_URL = import.meta.env.VITE_CONTENT_API_URL || "https://havyn-content.chijiokekosisochukwu.workers.dev";

function endpoint(path, params = {}) {
  const url = new URL(path, CONTENT_API_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function get(path, params) {
  const response = await fetch(endpoint(path, params));
  if (!response.ok) throw new Error("Havyn Discover is temporarily unavailable.");
  return response.json();
}

export function imageUrl(path, size = "w780") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : "";
}

function normalize(item, assumedMediaType) {
  return {
    id: String(item.id),
    mediaType: item.media_type === "tv" || item.mediaType === "tv" || assumedMediaType === "tv" ? "tv" : "movie",
    title: item.title || item.name || "Untitled",
    year: String(item.release_date || item.first_air_date || "").slice(0, 4),
    overview: item.overview || "",
    posterUrl: item.posterUrl || imageUrl(item.poster_path, "w342"),
    backdropUrl: item.backdropUrl || imageUrl(item.backdrop_path, "w1280"),
    rating: item.vote_average ? Number(item.vote_average).toFixed(1) : null
  };
}

export async function getHome() {
  const data = await get("/api/home");
  return {
    trending: (data.trending || data.results || []).map(normalize),
    spotlight: data.spotlight ? normalize(data.spotlight) : null
  };
}

export async function discover({ query = "", genre = "", type = "all", page = 1 } = {}) {
  const data = await get("/api/movies/discover", { query, genre, type, page });
  return {
    results: (data.items || data.results || []).map((item) => normalize(item, type === "all" ? undefined : type)),
    page: Number(data.page || page),
    totalPages: Number(data.totalPages || data.total_pages || 1)
  };
}

export async function searchYouTube(query) {
  const data = await get("/api/youtube/search", { query });
  return (data.items || []).map((item) => ({
    id: String(item.id),
    mediaType: "movie",
    title: item.title || "YouTube video",
    year: String(item.publishedAt || "").slice(0, 4),
    overview: item.description || "",
    posterUrl: item.thumbnailUrl || "",
    backdropUrl: item.thumbnailUrl || "",
    channelTitle: item.channelTitle || "YouTube"
  }));
}

export function youtubeProvider(videoId) {
  const id = encodeURIComponent(String(videoId || "").trim());
  const params = new URLSearchParams({ enablejsapi: "1", playsinline: "1", rel: "0" });
  if (typeof location !== "undefined") params.set("origin", location.origin);
  return {
    id: "youtube",
    name: "YouTube",
    adapterId: "youtube",
    origin: "https://www.youtube.com",
    capability: "synced",
    kind: "embed",
    source: "Havyn Sync",
    destination: `https://www.youtube.com/embed/${id}?${params}`
  };
}

export function youtubeBrowseProvider() {
  return {
    id: "youtube-browse",
    name: "YouTube",
    capability: "manual",
    kind: "embed",
    source: "YouTube browse",
    destination: "https://www.youtube.com/"
  };
}

export async function getProviders(content, season = 1, episode = 1) {
  // The chooser only shows providers that participate in Havyn's verified
  // playback contract. Availability links are not presented as faux sync.
  return syncedProviders(content, season, episode);
}

export async function getSeriesDetails(id) {
  const data = await get(`/api/movies/tv/${id}`);
  const item = data.item || {};
  return {
    seasons: (item.seasons || [])
      .filter((season) => Number(season.season_number) > 0)
      .map((season) => ({ number: Number(season.season_number), name: season.name || `Season ${season.season_number}`, episodeCount: Number(season.episode_count || 0) }))
  };
}

export async function getSeasonEpisodes(id, season) {
  const data = await get(`/api/movies/tv/${id}/season/${season}`);
  return (data.episodes || []).map((episode) => ({
    number: Number(episode.episode_number),
    name: episode.name || `Episode ${episode.episode_number}`,
    overview: episode.overview || "Synopsis is not available for this episode yet.",
    airDate: episode.air_date || "",
    runtime: Number(episode.runtime || 0),
    stillUrl: imageUrl(episode.still_path, "w342")
  }));
}

// Only providers with a tested inbound and outbound playback contract live here.
export function syncedProviders(content, season = 1, episode = 1) {
  const isSeries = content.mediaType === "tv";
  return [
    {
      id: "cinesrc", name: "CineSrc", adapterId: "cinesrc", origin: "https://cinesrc.st", capability: "synced", kind: "embed", source: "Havyn Sync",
      destination: isSeries ? `https://cinesrc.st/embed/tv/${content.id}?s=${season}&e=${episode}` : `https://cinesrc.st/embed/movie/${content.id}`
    },
    {
      id: "strigil", name: "Strigil", adapterId: "strigil", origin: "https://strigil.cc", capability: "synced", kind: "embed", source: "Havyn Sync",
      destination: isSeries ? `https://strigil.cc/embed/tv/${content.id}/${season}/${episode}?autoPlay=true` : `https://strigil.cc/embed/movie/${content.id}?autoPlay=true`
    },
    {
      id: "moviesapi", name: "MoviesAPI", adapterId: "moviesapi", origin: "https://moviesapi.to", capability: "synced", kind: "embed", source: "Havyn Sync",
      destination: isSeries ? `https://moviesapi.to/tv/${content.id}/${season}/${episode}?autoplay=false` : `https://moviesapi.to/movie/${content.id}?autoplay=false`
    }
  ];
}

export function providerDestination(name, title) {
  const query = encodeURIComponent(title);
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("netflix")) return `https://www.netflix.com/search?q=${query}`;
  if (normalized.includes("amazon") || normalized.includes("prime")) return `https://www.amazon.com/s?k=${query}&i=instant-video`;
  if (normalized.includes("disney")) return `https://www.disneyplus.com/search/${query}`;
  if (normalized.includes("apple")) return `https://tv.apple.com/search?term=${query}`;
  if (normalized.includes("max") || normalized.includes("hbo")) return `https://www.max.com/search?q=${query}`;
  if (normalized.includes("hulu")) return `https://www.hulu.com/search?q=${query}`;
  if (normalized.includes("paramount")) return `https://www.paramountplus.com/search/?q=${query}`;
  if (normalized.includes("peacock")) return `https://www.peacocktv.com/search?q=${query}`;
  if (normalized.includes("youtube")) return `https://www.youtube.com/results?search_query=${query}`;
  return "";
}

export const GENRES = [
  ["28", "Action"], ["12", "Adventure"], ["16", "Animation"], ["35", "Comedy"],
  ["80", "Crime"], ["99", "Documentary"], ["18", "Drama"], ["10751", "Family"],
  ["14", "Fantasy"], ["27", "Horror"], ["10749", "Romance"], ["878", "Science fiction"]
];
