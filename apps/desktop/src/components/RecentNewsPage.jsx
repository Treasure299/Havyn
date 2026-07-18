import { ArrowLeft, ArrowRight, Clock3, Newspaper } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getRecentNews } from "../lib/contentCatalog";

const categories = ["All", "Releases", "Casting", "Trailers", "Industry"];

function NewsCard({ article, featured = false }) {
  return (
    <a className={`news-card ${featured ? "featured-news-card" : ""}`} href={article.url} target="_blank" rel="noreferrer">
      {article.imageUrl && <img src={article.imageUrl} alt="" />}
      <span className="news-card-shade" />
      <span className="news-card-copy">
        <small>{article.category || "Industry"}</small>
        <strong>{article.title}</strong>
        {featured && article.summary && <p>{article.summary}</p>}
        <span>{article.source} · {article.publishedLabel || "Recently"}</span>
      </span>
      <ArrowRight size={17} />
    </a>
  );
}

export default function RecentNewsPage({ onBack }) {
  const [articles, setArticles] = useState([]);
  const [category, setCategory] = useState("All");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getRecentNews({ limit: 18 }).then((items) => {
      if (active) setArticles(items);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const visible = useMemo(() => category === "All"
    ? articles
    : articles.filter((item) => String(item.category || "").toLowerCase() === category.toLowerCase()), [articles, category]);

  return (
    <section className="content-page news-page">
      <div className="content-page-head">
        <button className="icon-button" type="button" title="Back to home" onClick={onBack}><ArrowLeft size={18} /></button>
        <div>
          <span className="section-eyebrow">ENTERTAINMENT</span>
          <h1>Recent News</h1>
          <p>The latest releases, casting announcements, trailers, and industry stories.</p>
        </div>
      </div>
      <div className="content-filter-tabs" role="tablist" aria-label="News categories">
        {categories.map((item) => (
          <button className={category === item ? "active" : ""} type="button" role="tab" aria-selected={category === item} onClick={() => setCategory(item)} key={item}>{item}</button>
        ))}
      </div>
      {loading ? <div className="content-loading">Loading recent stories…</div> : visible.length ? (
        <div className="news-page-grid">
          <NewsCard article={visible[0]} featured />
          <div className="news-side-stack">{visible.slice(1, 3).map((item) => <NewsCard article={item} key={item.id || item.url} />)}</div>
          <div className="news-card-grid">{visible.slice(3).map((item) => <NewsCard article={item} key={item.id || item.url} />)}</div>
        </div>
      ) : (
        <div className="content-empty glass">
          <Newspaper size={28} />
          <strong>No stories in this section yet</strong>
          <span>Havyn will refresh this feed as new stories are published.</span>
        </div>
      )}
      <div className="content-source-note"><Clock3 size={14} /> Headlines open on the original publisher’s website.</div>
    </section>
  );
}

