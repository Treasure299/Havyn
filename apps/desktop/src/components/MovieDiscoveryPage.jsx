import { ArrowLeft, ChevronRight, Clock3, Plus, Search, Shuffle, Star, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { contentCatalogConfigured, detectContentRegion, discoverMovies, getGenres, getMovieDetails, getMovieProviders, getTrendingMovies, providerDestination } from "../lib/contentCatalog";
import ProviderPickerModal from "./ProviderPickerModal";

function formatRuntime(minutes) {
  if (!minutes) return "Runtime unavailable";
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function MovieDiscoveryPage({ roomState, onBack }) {
  const [movies, setMovies] = useState([]);
  const [genres, setGenres] = useState([]);
  const [genre, setGenre] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [providerChoice, setProviderChoice] = useState(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [notice, setNotice] = useState("");
  const region = useMemo(() => detectContentRegion(), []);

  useEffect(() => {
    let active = true;
    Promise.all([getTrendingMovies({ region, limit: 12 }), getGenres()]).then(([movieItems, genreItems]) => {
      if (!active) return;
      setMovies(movieItems);
      setGenres(genreItems);
      setSelected(movieItems[0] || null);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [region]);

  useEffect(() => {
    if (!genre && !query.trim()) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      discoverMovies({ genre, query: query.trim(), region }).then((result) => {
        setMovies(result.items);
        setSelected(result.items[0] || null);
      }).finally(() => setLoading(false));
    }, query.trim() ? 350 : 0);
    return () => window.clearTimeout(timer);
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

  return (
    <section className="content-page discovery-page">
      <div className="content-page-head discovery-head">
        <button className="icon-button" type="button" title="Back to home" onClick={onBack}><ArrowLeft size={18} /></button>
        <div>
          <span className="section-eyebrow">DISCOVER</span>
          <h1>Find your next watch</h1>
          <p>Browse by genre, mood, release, or how much time you have.</p>
        </div>
        <button className="secondary-button surprise-button" type="button" onClick={surpriseMe}><Shuffle size={17} /> Surprise me</button>
      </div>
      <label className="movie-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies and shows" />{query && <button type="button" onClick={() => setQuery("")}><X size={15} /></button>}</label>
      <div className="genre-rail">
        <button className={!genre ? "active" : ""} type="button" onClick={() => setGenre("")}>All</button>
        {genres.slice(0, 9).map((item) => <button className={String(item.id) === genre ? "active" : ""} type="button" onClick={() => setGenre(String(item.id))} key={item.id}>{item.name}</button>)}
      </div>
      {!contentCatalogConfigured && <div className="catalog-setup-note">Movie discovery is ready for a TMDB or Havyn Content API key.</div>}
      <div className="discovery-layout">
        <div className="movie-results">
          <div className="section-heading-row"><h2>{query || genre ? "Results" : "Trending now"}</h2><span>{region}</span></div>
          {loading ? <div className="content-loading">Finding something good…</div> : movies.length ? (
            <div className="movie-poster-grid">
              {movies.map((movie) => (
                <button className={`movie-poster-card ${selected?.id === movie.id ? "selected" : ""}`} type="button" onClick={() => selectMovie(movie)} key={`${movie.mediaType}-${movie.id}`}>
                  <span className="poster-art">{movie.posterUrl ? <img src={movie.posterUrl} alt="" /> : <span>{movie.title.slice(0, 1)}</span>}</span>
                  <strong>{movie.title}</strong>
                  <small>{movie.year || "TBA"} · <Star size={12} /> {movie.rating ? movie.rating.toFixed(1) : "—"}</small>
                </button>
              ))}
            </div>
          ) : <div className="content-empty glass"><strong>No titles found</strong><span>Try another title or genre.</span></div>}
          <div className="recommendation-bands">
            <button type="button"><span>Fast-paced</span><small>High-energy picks for movie night.</small><ChevronRight size={17} /></button>
            <button type="button"><span>Under 2 hours</span><small>Great stories that respect your time.</small><Clock3 size={17} /></button>
            <button type="button"><span>Critically acclaimed</span><small>Top-rated films worth discussing.</small><Star size={17} /></button>
          </div>
        </div>
        <aside className="movie-detail-panel glass">
          {selected ? <>
            <div className="movie-detail-art">{selected.backdropUrl && <img src={selected.backdropUrl} alt="" />}</div>
            <h2>{selected.title}</h2>
            <div className="movie-meta"><span>{selected.year || "TBA"}</span><span>{formatRuntime(selected.runtime)}</span><span><Star size={13} /> {selected.rating ? selected.rating.toFixed(1) : "—"}</span></div>
            <p>{selected.overview || "More information will be available soon."}</p>
            <div className="movie-genres">{selected.genres?.map((item) => <span key={item.id}>{item.name}</span>)}</div>
            <button className="primary-button movie-room-button" type="button" disabled={creatingRoom} onClick={() => createMovieRoom(selected)}><Users size={17} /> {creatingRoom ? "Preparing room…" : "Start a room"}</button>
            <button className="secondary-button movie-watchlist-button" type="button"><Plus size={16} /> Add to watchlist</button>
          </> : <div className="content-empty"><strong>Select a movie</strong><span>Details and provider options will appear here.</span></div>}
        </aside>
      </div>
      {notice && <div className="social-note">{notice}</div>}
      {providerChoice && <ProviderPickerModal movie={providerChoice.movie} availability={providerChoice.availability} busy={creatingRoom} onCancel={() => setProviderChoice(null)} onSelect={(provider) => createMovieRoom(providerChoice.movie, provider)} />}
    </section>
  );
}
