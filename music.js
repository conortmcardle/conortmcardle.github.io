'use strict';

// ── API Config ────────────────────────────────────────────────────────────────

const MB_API   = 'https://musicbrainz.org/ws/2';
const WIKI_API = 'https://en.wikipedia.org/api/rest_v1';
const MB_HEADERS = { 'User-Agent': 'WhenItDropped/1.0 (https://conortmcardle.github.io)' };

// ── DOM Helpers ───────────────────────────────────────────────────────────────

const el     = id  => document.getElementById(id);
const show   = id  => { el(id).hidden = false; };
const hide   = id  => { el(id).hidden = true;  };
const setHTML = (id, html) => { el(id).innerHTML = html; };

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Fetch Helpers ─────────────────────────────────────────────────────────────

async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function mbFetch(path) {
  return safeFetch(`${MB_API}${path}`, { headers: MB_HEADERS });
}

function wikiFetch(path) {
  return safeFetch(`${WIKI_API}${path}`);
}

// ── Date Utilities ────────────────────────────────────────────────────────────

function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  return {
    year:  parts[0] ? parseInt(parts[0], 10) : null,
    month: parts[1] ? parseInt(parts[1], 10) : null,
    day:   parts[2] ? parseInt(parts[2], 10) : null,
    raw:   dateStr,
  };
}

function formatDate(dateStr) {
  if (!dateStr) return 'Unknown date';
  const parts = dateStr.split('-');
  if (parts.length === 1) return parts[0];
  try {
    const iso = parts.length === 2 ? `${dateStr}-01` : dateStr;
    const d = new Date(iso + 'T00:00:00');
    const opts = { year: 'numeric', month: 'long', ...(parts.length === 3 && { day: 'numeric' }) };
    return d.toLocaleDateString('en-US', opts);
  } catch {
    return dateStr;
  }
}

// Lower score = more canonical. Album/Single before Compilation/Live.
const RELEASE_TYPE_RANK = { 'Album': 0, 'Single': 1, 'EP': 2, 'Compilation': 3, 'Live': 4 };

// Live albums have primary-type "Album" in MusicBrainz, so check secondary-types
// first (available when using inc=release-groups on a full recording lookup).
function releaseTypeScore(r) {
  const secondary = r['release-group']?.['secondary-types'] ?? [];
  if (secondary.includes('Live'))        return RELEASE_TYPE_RANK['Live'];
  if (secondary.includes('Compilation')) return RELEASE_TYPE_RANK['Compilation'];
  return RELEASE_TYPE_RANK[r['release-group']?.['primary-type']] ?? 5;
}

function getBestRelease(releases) {
  if (!releases?.length) return null;

  const official = releases.filter(r => r.status === 'Official' || !r.status);
  const pool = official.length ? official : releases;

  const dated = pool.filter(r => r.date);
  if (!dated.length) return pool[0] ?? releases[0];

  const isFullDate = r => /^\d{4}-\d{2}-\d{2}$/.test(r.date);

  // Score by type (studio album wins), then full-date bonus. No country bias —
  // that was causing US compilations (1981) to outscore the original UK album (1977).
  const scored = dated.map(r => ({
    r,
    score: releaseTypeScore(r) * 100 + (isFullDate(r) ? 0 : 10),
  }));

  scored.sort((a, b) => a.score - b.score || a.r.date.localeCompare(b.r.date));
  return scored[0].r;
}

// ── MusicBrainz API ───────────────────────────────────────────────────────────

async function searchRecordings(title, artist) {
  let q = `recording:"${title.replace(/"/g, '')}"`;
  if (artist) q += ` AND artist:"${artist.replace(/"/g, '')}"`;
  q += ' AND status:Official';
  const path = `/recording?query=${encodeURIComponent(q)}&fmt=json&limit=50&inc=releases+artist-credits`;
  return mbFetch(path);
}

async function getArtistDetails(artistId) {
  return mbFetch(`/artist/${artistId}?fmt=json`);
}

async function getConcurrentReleases(year, month, day) {
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  const q = `date:${dateStr} AND status:Official`;
  const path = `/release?query=${encodeURIComponent(q)}&fmt=json&limit=25&inc=artist-credits`;
  return mbFetch(path);
}

async function getTVPremieres(year, month, day) {
  const pad    = n => String(n).padStart(2, '0');
  const center = new Date(Date.UTC(year, month - 1, day));
  const dates  = [];
  for (let offset = -30; offset <= 30; offset++) {
    const d = new Date(center);
    d.setUTCDate(d.getUTCDate() + offset);
    dates.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  const results = await Promise.all(
    dates.map(ds => safeFetch(`https://api.tvmaze.com/schedule?date=${ds}&country=US`))
  );
  return results.filter(Boolean).flat();
}

async function getMovieReleases(year, month, day) {
  const pad    = n => String(n).padStart(2, '0');
  const center = new Date(Date.UTC(year, month - 1, day));
  const start  = new Date(center); start.setUTCDate(start.getUTCDate() - 4);
  const end    = new Date(center); end.setUTCDate(end.getUTCDate() + 4);
  const fmtD   = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const query = `
    SELECT DISTINCT ?film ?filmLabel ?directorLabel ?date ?poster WHERE {
      ?film wdt:P31 wd:Q11424.
      ?film wdt:P577 ?date.
      FILTER(?date >= "${fmtD(start)}T00:00:00Z"^^xsd:dateTime && ?date <= "${fmtD(end)}T23:59:59Z"^^xsd:dateTime)
      OPTIONAL { ?film wdt:P57 ?director. }
      OPTIONAL { ?film wdt:P18 ?poster. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 20
  `;
  return safeFetch(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`
  );
}

// ── Wikipedia API ─────────────────────────────────────────────────────────────

async function getOnThisDay(month, day) {
  const pad = n => String(n).padStart(2, '0');
  return wikiFetch(`/feed/onthisday/all/${pad(month)}/${pad(day)}`);
}

async function getWikiSummary(title) {
  const slug = encodeURIComponent(title.replace(/ /g, '_'));
  return wikiFetch(`/page/summary/${slug}`);
}

async function getSongWiki(title, artistName) {
  // Try a few title variants to find the right Wikipedia article
  const variants = [
    title,
    `${title} (song)`,
    `${title} (${artistName} song)`,
  ];
  for (const v of variants) {
    const data = await getWikiSummary(v);
    if (data && data.type !== 'disambiguation' && data.extract) return data;
  }
  return null;
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function renderPicker(recordings) {
  if (!recordings?.length) {
    setHTML('picker-list', '<p class="no-data">No songs found — try adjusting your search.</p>');
    return;
  }

  // Sort by earliest official release date. The original studio recording was
  // released in 1977; live recordings from concerts are always from later years,
  // so this naturally surfaces the original version before live/compilation entries.
  // MB relevance score is used only as a tiebreaker.
  const earliestDate = rec => {
    const dates = (rec.releases ?? [])
      .filter(r => r.date && (r.status === 'Official' || !r.status))
      .map(r => r.date)
      .sort();
    return dates[0] ?? '9999';
  };

  const sorted = [...recordings].sort((a, b) => {
    const da = earliestDate(a);
    const db = earliestDate(b);
    if (da !== db) return da.localeCompare(db);
    return (b.score ?? 0) - (a.score ?? 0);
  }).slice(0, 8);

  const items = sorted.map((rec, i) => {
    const artist  = rec['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist';
    const release = getBestRelease(rec.releases);
    const date    = release?.date ? formatDate(release.date) : 'Date unknown';
    const album   = release?.title ?? '';
    return `
      <div class="picker-item" data-index="${i}">
        <div class="picker-left">
          <div class="picker-song">${escHtml(rec.title)}</div>
          <div class="picker-artist">${escHtml(artist)}</div>
        </div>
        <div class="picker-right">
          <div class="picker-date">${escHtml(date)}</div>
          ${album ? `<div class="picker-album">${escHtml(album)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  setHTML('picker-list', items);

  document.querySelectorAll('.picker-item').forEach(item => {
    item.addEventListener('click', () => {
      selectRecording(sorted[parseInt(item.dataset.index, 10)]);
    });
  });
}

function renderSongHeader(title, artistName, release) {
  const dateStr = release?.date ? formatDate(release.date) : 'Date unknown';
  el('song-header').innerHTML = `
    <div class="song-header">
      <div class="song-header-title">${escHtml(title)}</div>
      <div class="song-header-artist">${escHtml(artistName)}</div>
      <div class="song-header-date">Released ${escHtml(dateStr)}</div>
    </div>`;
}

function detail(label, value) {
  return `
    <div class="detail-block">
      <div class="detail-label">${escHtml(label)}</div>
      <div class="detail-value">${escHtml(String(value))}</div>
    </div>`;
}

function renderSongPanel(rec, release, wikiData) {
  let html = '';

  const rgId = release?.['release-group']?.id;
  if (rgId) {
    html += `<img class="cover-img"
      src="https://coverartarchive.org/release-group/${escHtml(rgId)}/front-250"
      alt="Album cover"
      onerror="this.style.display='none'">`;
  }

  if (release?.date)    html += detail('Release Date', formatDate(release.date));
  if (release?.title)   html += detail('Album / Release', release.title);
  if (release?.country) html += detail('Country', release.country);

  if (rec.length) {
    const mins = Math.floor(rec.length / 60000);
    const secs = String(Math.floor((rec.length % 60000) / 1000)).padStart(2, '0');
    html += detail('Duration', `${mins}:${secs}`);
  }

  if (wikiData?.extract) {
    const excerpt = wikiData.extract.split('. ').slice(0, 4).join('. ') + '.';
    html += `<div class="wiki-extract">${escHtml(excerpt)}</div>`;
    if (wikiData.content_urls?.desktop?.page) {
      html += `<a class="wiki-link" href="${escHtml(wikiData.content_urls.desktop.page)}" target="_blank" rel="noopener">Read on Wikipedia →</a>`;
    }
  }

  setHTML('panel-song-body', html || '<p class="no-data">No details available.</p>');
}

function renderHistoryPanel(data, releaseYear) {
  if (!data || !releaseYear) {
    setHTML('panel-history-body', '<p class="no-data">No historical events found for this date.</p>');
    return;
  }

  // Combine events, births and deaths all from the exact release year.
  const byYear = arr => (arr ?? []).filter(e => e.year === releaseYear);
  const events = [
    ...byYear(data.events),
    ...byYear(data.births).map(e => ({ ...e, text: `Born: ${e.text}` })),
    ...byYear(data.deaths).map(e => ({ ...e, text: `Died: ${e.text}` })),
  ].slice(0, 4);

  if (!events.length) {
    setHTML('panel-history-body', '<p class="no-data">No historical events found for this date.</p>');
    return;
  }

  const html = events.map(event => `
    <div class="history-event">
      <div class="history-year">${escHtml(String(event.year))}</div>
      <div class="history-text">${escHtml(event.text)}</div>
    </div>`).join('');

  setHTML('panel-history-body', html);
}

function renderConcurrentPanel(data, currentTitle, artistName) {
  if (!data?.releases?.length) {
    setHTML('panel-concurrent-body', '<p class="no-data">No concurrent releases found.</p>');
    return;
  }

  const seen = new Set();
  const releases = data.releases.filter(r => {
    const rArtist = r['artist-credit']?.[0]?.artist?.name ?? '';
    // Exclude the current song's artist and deduplicate
    if (rArtist.toLowerCase() === artistName.toLowerCase()) return false;
    const key = `${r.title}||${rArtist}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);

  if (!releases.length) {
    setHTML('panel-concurrent-body', '<p class="no-data">No other releases found in this period.</p>');
    return;
  }

  const html = releases.map(r => {
    const artist  = r['artist-credit']?.[0]?.artist?.name ?? 'Unknown';
    const dateStr = r.date ? formatDate(r.date) : '';
    return `
      <div class="concurrent-item">
        <div class="concurrent-title">${escHtml(r.title)}</div>
        <div class="concurrent-artist">${escHtml(artist)}</div>
        ${dateStr ? `<div class="concurrent-date">${escHtml(dateStr)}</div>` : ''}
      </div>`;
  }).join('');

  setHTML('panel-concurrent-body', html);
}

function renderTVPanel(data) {
  if (!Array.isArray(data) || !data.length) {
    setHTML('panel-tv-body', '<p class="no-data">No TV premieres found for this date.</p>');
    return;
  }

  const seen = new Set();
  const premieres = data.filter(ep => {
    if (ep.season !== 1 || ep.number !== 1) return false;
    const key = ep.show?.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a.airdate ?? '').localeCompare(b.airdate ?? '')).slice(0, 8);

  if (!premieres.length) {
    setHTML('panel-tv-body', '<p class="no-data">No TV premieres found for this date.</p>');
    return;
  }

  const html = premieres.map(ep => {
    const show    = ep.show ?? {};
    const network = show.network?.name ?? show.webChannel?.name ?? '';
    const genres  = show.genres?.slice(0, 2).join(', ') ?? '';
    const airdate = ep.airdate ? formatDate(ep.airdate) : '';
    const img     = show.image?.medium ?? '';
    return `
      <div class="tv-item">
        ${img ? `<img class="item-poster" src="${escHtml(img)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="tv-info">
          <div class="tv-title">${escHtml(show.name ?? ep.name)}</div>
          ${network ? `<div class="tv-network">${escHtml(network)}</div>` : ''}
          ${genres  ? `<div class="tv-genre">${escHtml(genres)}</div>`   : ''}
          ${airdate ? `<div class="tv-date">${escHtml(airdate)}</div>`   : ''}
        </div>
      </div>`;
  }).join('');

  setHTML('panel-tv-body', html);
}

function renderMoviePanel(data) {
  const bindings = data?.results?.bindings ?? [];
  if (!bindings.length) {
    setHTML('panel-movies-body', '<p class="no-data">No movies found for this date.</p>');
    return;
  }

  const seen = new Set();
  const movies = bindings.filter(b => {
    const title = b.filmLabel?.value;
    if (!title || /^Q\d+$/.test(title) || seen.has(title)) return false;
    seen.add(title);
    return true;
  }).slice(0, 8);

  if (!movies.length) {
    setHTML('panel-movies-body', '<p class="no-data">No movies found for this date.</p>');
    return;
  }

  const html = movies.map(b => {
    const title     = b.filmLabel?.value     ?? '';
    const director  = b.directorLabel?.value ?? '';
    const rawDate   = b.date?.value          ?? '';
    const dateStr   = rawDate ? formatDate(rawDate.slice(0, 10)) : '';
    const rawPoster = b.poster?.value        ?? '';
    const posterUrl = rawPoster ? rawPoster.replace(/^http:/, 'https:') + '?width=200' : '';
    return `
      <div class="movie-item">
        ${posterUrl ? `<img class="item-poster" src="${escHtml(posterUrl)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="movie-info">
          <div class="movie-title">${escHtml(title)}</div>
          ${director ? `<div class="movie-director">dir. ${escHtml(director)}</div>` : ''}
          ${dateStr  ? `<div class="movie-date">${escHtml(dateStr)}</div>`           : ''}
        </div>
      </div>`;
  }).join('');

  setHTML('panel-movies-body', html);
}

function renderArtistPanel(mbData, wikiData) {
  let html = '';

  const name = wikiData?.title ?? mbData?.name ?? '';
  const area = mbData?.area?.name ?? mbData?.['begin-area']?.name ?? '';
  const began = mbData?.['life-span']?.begin?.split('-')[0] ?? '';

  if (name)  html += `<div class="artist-name">${escHtml(name)}</div>`;
  if (area)  html += `<div class="artist-origin">From ${escHtml(area)}</div>`;
  if (began) html += detail('Active Since', began);

  if (wikiData?.extract) {
    const excerpt = wikiData.extract.split('. ').slice(0, 5).join('. ') + '.';
    html += `<div class="wiki-extract">${escHtml(excerpt)}</div>`;
    if (wikiData.content_urls?.desktop?.page) {
      html += `<a class="wiki-link" href="${escHtml(wikiData.content_urls.desktop.page)}" target="_blank" rel="noopener">Read on Wikipedia →</a>`;
    }
  }

  setHTML('panel-artist-body', html || '<p class="no-data">No artist info available.</p>');
}

// ── Core Flow ─────────────────────────────────────────────────────────────────

function resetPanels() {
  ['panel-song-body', 'panel-history-body', 'panel-concurrent-body', 'panel-artist-body', 'panel-tv-body', 'panel-movies-body'].forEach(id => {
    setHTML(id, '<div class="loading">Loading…</div>');
  });
}

async function selectRecording(rec) {
  const title      = rec.title;
  const credit     = rec['artist-credit']?.[0];
  const artistName = credit?.artist?.name ?? 'Unknown';
  const artistId   = credit?.artist?.id ?? null;

  hide('picker-section');
  show('results-section');
  resetPanels();
  el('results-section').scrollIntoView({ behavior: 'smooth' });

  // Full recording lookup: gets ALL releases with release-group secondary-types
  // (e.g. "Live", "Compilation"), so getBestRelease can correctly prefer the
  // original studio album over compilations and live albums. The search result
  // only returns a truncated release list without secondary-types.
  const fullRec = await mbFetch(`/recording/${rec.id}?fmt=json&inc=releases+artist-credits+release-groups`);
  const release = getBestRelease(fullRec?.releases ?? rec.releases);
  const date    = parseDate(release?.date);

  renderSongHeader(title, artistName, release);

  // Fire each fetch independently; render each panel as soon as its data arrives
  const hasFullDate = date?.year && date?.month && date?.day;

  getSongWiki(title, artistName)
    .then(d => renderSongPanel(rec, release, d));

  if (date?.month && date?.day) {
    getOnThisDay(date.month, date.day)
      .then(d => renderHistoryPanel(d, date?.year ?? 0));
  } else {
    renderHistoryPanel(null, 0);
  }

  if (hasFullDate) {
    getConcurrentReleases(date.year, date.month, date.day)
      .then(d => renderConcurrentPanel(d, title, artistName));
    getTVPremieres(date.year, date.month, date.day)
      .then(d => renderTVPanel(d));
    getMovieReleases(date.year, date.month, date.day)
      .then(d => renderMoviePanel(d));
  } else {
    renderConcurrentPanel(null, title, artistName);
    renderTVPanel(null);
    renderMoviePanel(null);
  }

  // Artist panel needs both MB + Wikipedia; wait for both together
  Promise.all([
    artistId ? getArtistDetails(artistId) : Promise.resolve(null),
    getWikiSummary(artistName),
  ]).then(([artistMb, artistWiki]) => {
    renderArtistPanel(artistMb, artistWiki?.type === 'disambiguation' ? null : artistWiki);
  });
}

function goToSearch() {
  hide('picker-section');
  hide('results-section');
  el('search-section').scrollIntoView({ behavior: 'smooth' });
  el('song-input').focus();
}

// ── Event Listeners ───────────────────────────────────────────────────────────

el('search-form').addEventListener('submit', async e => {
  e.preventDefault();

  const title  = el('song-input').value.trim();
  const artist = el('artist-input').value.trim();
  if (!title) return;

  hide('results-section');
  show('picker-section');
  setHTML('picker-list', '<div class="loading">Searching…</div>');
  el('picker-section').scrollIntoView({ behavior: 'smooth' });

  const data = await searchRecordings(title, artist);
  renderPicker(data?.recordings ?? []);
});

el('back-btn').addEventListener('click', goToSearch);
el('new-search-btn').addEventListener('click', goToSearch);
