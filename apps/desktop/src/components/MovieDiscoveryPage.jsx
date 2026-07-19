import { ArrowLeft, Bookmark, BookmarkCheck, Plus, Search, Shuffle, Star, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { contentCatalogConfigured, detectContentRegion, discoverMovies, getGenres, getMovieDetails, getMovieProviders, providerDestination } from "../lib/contentCatalog";
import ProviderPickerModal from "./ProviderPickerModal";

function formatRuntime(minutes) {
  if (!minutes) return "Runtime unavailable";
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function MovieDiscoveryPage({ roomState, userId, onBack }) {
  const [movies, setMovies] = useState([]);
  const [genres, setGenres] = useState([]);
  const [genre, setGenre] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [providerChoice, setProviderChoice] = useState(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [notice, setNotice] = useState("");
  const [watchlist, setWatchlist] = useState([]);
  const [showWatchlist, setShowWatchlist] = useState(false);
  const [browseSelection, setBrowseSelection] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const region = useMemo(() => detectContentRegion(), []);
  const watchlistKey = useMemo(() => `havyn:watchlist:${userId || "local"}`, [userId]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(watchlistKey) || "[]");
      setWatchlist(Array.isArray(saved) ? saved : []);
    } catch {
      setWatchlist([]);
    }
  }, [watchlistKey]);

  useEffect(() => {
    let active = true;
    getGenres().then((items) => { if (active) setGenres(items); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      discoverMovies({ genre, query: query.trim(), region, page: 1 }).then((result) => {
        if (!active) return;
        setMovies(result.items);
        setPage(result.page || 1);
        setTotalPages(result.totalPages || 1);
        setSelected(result.items[0] || null);
      }).finally(() => { if (active) setLoading(false); });
    }, query.trim() ? 350 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [genre, query, region]);

  async function selectMovie(movie) {
    setSelected(movie);
    const details = await getMovieDetails(movie.id, movie.mediaType).catch(() => null);
    if (details) setSelected(details);
  }

  async function createMovieRoom(movie, provider = undefined) {
    if (!movie) return;
    if (provider === undefined) {
      setCreatingRoom(true);
      try {
        const availability = await getMovieProviders(movie.id, movie.mediaType, region);
        const usable = availability.providers.filter((item) => item.url || /netflix|amazon|prime video|disney|apple tv|max|hbo|hulu|paramount|peacock|youtube/i.test(item.name));
        if (usable.length === 1) {
          await createMovieRoom(movie, usable[0]);
          return;
        }
        if (usable.length > 1) {
          setProviderChoice({ movie, availability: { ...availability, providers: usable } });
          return;
        }
        await roomState.createRoom(movie.title, { visibility: "private", discoveryMovie: movie });
      } catch {
        await roomState.createRoom(movie.title, { visibility: "private", discoveryMovie: movie });
      } finally {
        setCreatingRoom(false);
      }
      return;
    }
    setCreatingRoom(true);
    const destination = provider?.destination || providerDestination(provider, movie.title);
    try {
      await roomState.createRoom(movie.title, {
        visibility: "private",
        initialUrl: destination,
        discoveryMovie: movie,
        provider: provider ? { id: provider.id, name: provider.name } : null
      });
    } finally {
      setCreatingRoom(false);
      setProviderChoice(null);
    }
  }

  function surpriseMe() {
    if (!movies.length) return;
    void selectMovie(movies[Math.floor(Math.random() * movies.length)]);
  }

  function toggleWatchlist(movie) {
    if (!movie) return;
    const exists = watchlist.some((item) => item.id === movie.id && item.mediaType === movie.mediaType);
    const next = exists
      ? watchlist.filter((item) => !(item.id === movie.id && item.mediaType === movie.mediaType))
      : [{ ...movie }, ...watchlist];
    setWatchlist(next);
    localStorage.setItem(watchlistKey, JSON.stringify(next));
    setNotice(exists ? "Removed from watchlist" : "Added to watchlist");
    window.setTimeout(() => setNotice(""), 1800);
  }

  function openWatchlist() {
    setBrowseSelection(selected);
    setShowWatchlist(true);
    setSelected(watchlist[0] || null);
  }

  function closeWatchlist() {
    setShowWatchlist(false);
    setSelected(browseSelection || movies[0] || null);
  }

  async function loadMore() {
    if (loadingMore || page >= totalPages) return;
    setLoadingMore(true);
    try {
      const result = await discoverMovies({ genre, query: query.trim(), region, page: page + 1 });
      setMovies((current) => {
        const existing = new Set(current.map((item) => `${item.mediaType}-${item.id}`));
        return [...current, ...result.items.filter((item) => !existing.has(`${item.mediaType}-${item.id}`))];
      });
      setPage(result.page || page + 1);
      setTotalPages(result.totalPages || totalPages);
    } finally {
      setLoadingMore(false);
    }
  }

  const visibleMovies = showWatchlist ? watchlist : movies;
  const selectedIsSaved = Boolean(selected && watchlist.some((item) => item.id === selected.id && item.mediaType === selected.mediaType));

  return (
    <section className="content-page discovery-page">
      <div className="content-page-head discovery-head">
        <button className="icon-button" type="button" title={showWatchlist ? "Back to movies" : "Back to home"} onClick={showWatchlist ? closeWatchlist : onBack}><ArrowLeft size={18} /></button>
        <div>
          <span className="section-eyebrow">DISCOVER</span>
          <h1>Find your next watch</h1>
          <p>Browse by genre, mood, release, or how much time you have.</p>
        </div>
        <div className="discovery-head-actions">
          <button className={`secondary-button ${showWatchlist ? "is-active" : ""}`} type="button" onClick={openWatchlist}><Bookmark size={17} /> Watchlist <span>{watchlist.length}</span></button>
          <button className="secondary-button surprise-button" type="button" onClick={surpriseMe}><Shuffle size={17} /> Surprise me</button>
        </div>
      </div>
      <label className="movie-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies and shows" />{query && <button type="button" onClick={() => setQuery("")}><X size={15} /></button>}</label>
      <div className="genre-rail">
        <button className={!genre && !showWatchlist ? "active" : ""} type="button" onClick={() => { if (showWatchlist) closeWatchlist(); setGenre(""); }}>All</button>
        {genres.slice(0, 9).map((item) => <button className={String(item.id) === genre && !showWatchlist ? "active" : ""} type="button" onClick={() => { if (showWatchlist) closeWatchlist(); setGenre(String(item.id)); }} key={item.id}>{item.name}</button>)}
      </div>
      {!contentCatalogConfigured && <div className="catalog-setup-note">Movie discovery is ready for a TMDB or Havyn Content API key.</div>}
      <div className="discovery-layout">
        <div className="movie-results">
          <div className="section-heading-row"><h2>{showWatchlist ? "Your watchlist" : query || genre ? "Results" : "Popular now"}</h2><span>{showWatchlist ? `${watchlist.length} saved` : `${movies.length} titles`}</span></div>
          {!showWatchlist && loading ? <div className="content-loading">Finding something good…</div> : visibleMovies.length ? (
            <div className="movie-poster-grid">
              {visibleMovies.map((movie) => (
                <button className={`movie-poster-card ${selected?.id === movie.id ? "selected" : ""}`} type="button" onClick={() => selectMovie(movie)} key={`${movie.mediaType}-${movie.id}`}>
                  <span className="poster-art">{movie.posterUrl ? <img src={movie.posterUrl} alt="" /> : <span>{movie.title.slice(0, 1)}</span>}</span>
                  <strong>{movie.title}</strong>
                  <small>{movie.year || "TBA"} · <Star size={12} /> {movie.rating ? movie.rating.toFixed(1) : "—"}</small>
                </button>
              ))}
            </div>
          ) : <div className="content-empty glass"><Bookmark size={24} /><strong>{showWatchlist ? "Your watchlist is empty" : "No titles found"}</strong><span>{showWatchlist ? "Save a title and it will appear here." : "Try another title or genre."}</span></div>}
          {!showWatchlist && !loading && page < totalPages && <button className="movie-load-more" type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "Loading..." : "Load more..."}</button>}
        </div>
        <aside className="movie-detail-panel glass">
          {selected ? <>
            <div className="movie-detail-art">{selected.backdropUrl && <img src={selected.backdropUrl} alt="" />}</div>
            <h2>{selected.title}</h2>
            <div className="movie-meta"><span>{selected.year || "TBA"}</span><span>{formatRuntime(selected.runtime)}</span><span><Star size={13} /> {selected.rating ? selected.rating.toFixed(1) : "—"}</span></div>
            <p>{selected.overview || "More information will be available soon."}</p>
            <div className="movie-genres">{selected.genres?.map((item) => <span key={item.id}>{item.name}</span>)}</div>
            <button className="primary-button movie-room-button" type="button" disabled={creatingRoom} onClick={() => createMovieRoom(selected)}><Users size={17} /> {creatingRoom ? "Preparing room…" : "Start a room"}</button>
            <button className={`secondary-button movie-watchlist-button ${selectedIsSaved ? "is-active" : ""}`} type="button" onClick={() => toggleWatchlist(selected)}>{selectedIsSaved ? <BookmarkCheck size={16} /> : <Plus size={16} />} {selectedIsSaved ? "Remove from watchlist" : "Add to watchlist"}</button>
          </> : <div className="content-empty"><strong>Select a movie</strong><span>Details and provider options will appear here.</span></div>}
        </aside>
      </div>
      {notice && <div className="social-note">{notice}</div>}
      {providerChoice && <ProviderPickerModal movie={providerChoice.movie} availability={providerChoice.availability} busy={creatingRoom} onCancel={() => setProviderChoice(null)} onSelect={(provider) => createMovieRoom(providerChoice.movie, provider)} />}
    </section>
  );
}
