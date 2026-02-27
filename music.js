'use strict';

// ── API Config ────────────────────────────────────────────────────────────────

const MB_API      = 'https://musicbrainz.org/ws/2';
const WIKI_API    = 'https://en.wikipedia.org/api/rest_v1';
const TMDB_TOKEN  = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIwYzk3Y2ZmNGE2NDY5MWM5NTgxNjgzMzNmNWJjZGQyMyIsIm5iZiI6MTUxMzAxNzA4OC40NzksInN1YiI6IjVhMmVjZjAwOTI1MTQxMDMyYzE2OTAwOCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.TsyvP2XLtoS-QMCAVaLUF4MpONaDoK61-z4CXYjz2N0';
const MB_HEADERS  = { 'User-Agent': 'WhenItDropped/1.0 (https://conortmcardle.github.io)' };

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

// ── Progress Bar ──────────────────────────────────────────────────────────────

let _progressTotal = 0;
let _progressDone  = 0;

function initProgress(n) {
  _progressTotal = n;
  _progressDone  = 0;
  el('load-bar').style.width = '4%'; // show it's started
  el('load-progress').hidden = false;
}

function tickProgress() {
  _progressDone = Math.min(_progressDone + 1, _progressTotal);
  const pct = Math.round((_progressDone / _progressTotal) * 100);
  el('load-bar').style.width = `${pct}%`;
  if (_progressDone >= _progressTotal) {
    setTimeout(() => { el('load-progress').hidden = true; }, 700);
  }
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

async function searchReleaseGroups(title, artist) {
  let q = `releasegroup:"${title.replace(/"/g, '')}"`;
  if (artist) q += ` AND artist:"${artist.replace(/"/g, '')}"`;
  const path = `/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=20&inc=artist-credits`;
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
  const [usResults, ukResults] = await Promise.all([
    Promise.all(dates.map(ds => safeFetch(`https://api.tvmaze.com/schedule?date=${ds}&country=US`))),
    Promise.all(dates.map(ds => safeFetch(`https://api.tvmaze.com/schedule?date=${ds}&country=GB`))),
  ]);
  return [...usResults.filter(Boolean).flat(), ...ukResults.filter(Boolean).flat()];
}

async function getMovieReleases(year, month, day) {
  const pad    = n => String(n).padStart(2, '0');
  const center = new Date(Date.UTC(year, month - 1, day));
  const start  = new Date(center); start.setUTCDate(start.getUTCDate() - 4);
  const end    = new Date(center); end.setUTCDate(end.getUTCDate() + 4);
  const fmtD   = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

  const url = `https://api.themoviedb.org/3/discover/movie` +
    `?primary_release_date.gte=${fmtD(start)}` +
    `&primary_release_date.lte=${fmtD(end)}` +
    `&sort_by=popularity.desc` +
    `&language=en-US`;

  const data = await safeFetch(url, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  });
  if (!data?.results?.length) return [];

  const top = data.results.slice(0, 8);

  // Fetch credits for all movies in parallel — one extra call per film but
  // they resolve concurrently so the wall-clock cost is just one round-trip.
  await Promise.all(top.map(async m => {
    const credits = await safeFetch(
      `https://api.themoviedb.org/3/movie/${m.id}/credits?language=en-US`,
      { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } }
    );
    if (!credits?.crew) return;
    const seen = new Set();
    const uniq = name => { if (seen.has(name)) return false; seen.add(name); return true; };
    m._directors = credits.crew.filter(c => c.job === 'Director').map(c => c.name).filter(uniq);
    m._writers   = credits.crew
      .filter(c => ['Screenplay', 'Writer', 'Story'].includes(c.job))
      .map(c => c.name).filter(uniq).slice(0, 2);
  }));

  return top.map(m => ({
    title:     m.title,
    date:      m.release_date ?? '',
    posterUrl: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : null,
    tmdbUrl:   `https://www.themoviedb.org/movie/${m.id}`,
    directors: m._directors ?? [],
    writers:   m._writers   ?? [],
  }));
}

// ── Wikipedia API ─────────────────────────────────────────────────────────────

async function getThisWeekInHistory(year, month, day) {
  const pad    = n => String(n).padStart(2, '0');
  const center = new Date(Date.UTC(year, month - 1, day));
  const fetches = [];
  for (let offset = -4; offset <= 4; offset++) {
    const d = new Date(center);
    d.setUTCDate(d.getUTCDate() + offset);
    fetches.push(wikiFetch(`/feed/onthisday/all/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`));
  }
  const results = await Promise.all(fetches);
  // Pool events / births / deaths from all 9 days
  const pool = { events: [], births: [], deaths: [] };
  for (const r of results) {
    if (!r) continue;
    pool.events.push(...(r.events ?? []));
    pool.births.push(...(r.births ?? []));
    pool.deaths.push(...(r.deaths ?? []));
  }
  return pool;
}

async function getWikiSummary(title) {
  const slug = encodeURIComponent(title.replace(/ /g, '_'));
  return wikiFetch(`/page/summary/${slug}`);
}

async function getAlbumWiki(title, artistName) {
  const variants = [
    `${title} (${artistName} album)`,
    `${title} (album)`,
    title,
  ];
  for (const v of variants) {
    const data = await getWikiSummary(v);
    if (data && data.type !== 'disambiguation' && data.extract) return data;
  }
  return null;
}

async function getSongWiki(title, artistName) {
  // Try specific variants first so "Yellow (Coldplay song)" wins over the
  // color article, and "Pink (Aerosmith song)" wins over the color article.
  // Bare title is last resort — it's often the wrong thing entirely.
  const variants = [
    `${title} (${artistName} song)`,
    `${title} (song)`,
    title,
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

function renderAlbumPicker(groups) {
  if (!groups?.length) {
    setHTML('picker-list', '<p class="no-data">No albums found — try adjusting your search.</p>');
    return;
  }

  const sorted = [...groups]
    .sort((a, b) => (a['first-release-date'] ?? '9999').localeCompare(b['first-release-date'] ?? '9999'))
    .slice(0, 8);

  const items = sorted.map((rg, i) => {
    const artist = rg['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist';
    const year   = rg['first-release-date']?.split('-')[0] ?? '';
    const type   = rg['primary-type'] ?? '';
    return `
      <div class="picker-item" data-index="${i}">
        <div class="picker-left">
          <div class="picker-song">${escHtml(rg.title)}</div>
          <div class="picker-artist">${escHtml(artist)}</div>
        </div>
        <div class="picker-right">
          ${year ? `<div class="picker-date">${escHtml(year)}</div>` : ''}
          ${type ? `<div class="picker-album">${escHtml(type)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  setHTML('picker-list', items);

  document.querySelectorAll('.picker-item').forEach(item => {
    item.addEventListener('click', () => {
      selectReleaseGroup(sorted[parseInt(item.dataset.index, 10)]);
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
    const mbRgUrl = `https://musicbrainz.org/release-group/${escHtml(rgId)}`;
    html += `<a href="${mbRgUrl}" target="_blank" rel="noopener"><img class="cover-img"
      src="https://coverartarchive.org/release-group/${escHtml(rgId)}/front-250"
      alt="Album cover"
      onerror="this.style.display='none'"></a>`;
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

function renderAlbumPanel(rg, wikiData) {
  let html = '';

  if (rg.id) {
    const mbRgUrl = `https://musicbrainz.org/release-group/${escHtml(rg.id)}`;
    html += `<a href="${mbRgUrl}" target="_blank" rel="noopener"><img class="cover-img"
      src="https://coverartarchive.org/release-group/${escHtml(rg.id)}/front-250"
      alt="Album cover"
      onerror="this.style.display='none'"></a>`;
  }

  if (rg['first-release-date']) html += detail('Release Date', formatDate(rg['first-release-date']));
  if (rg['primary-type'])       html += detail('Type', rg['primary-type']);

  if (wikiData?.extract) {
    const excerpt = wikiData.extract.split('. ').slice(0, 4).join('. ') + '.';
    html += `<div class="wiki-extract">${escHtml(excerpt)}</div>`;
    if (wikiData.content_urls?.desktop?.page) {
      html += `<a class="wiki-link" href="${escHtml(wikiData.content_urls.desktop.page)}" target="_blank" rel="noopener">Read on Wikipedia →</a>`;
    }
  }

  setHTML('panel-song-body', html || '<p class="no-data">No album details available.</p>');
}

function renderHistoryPanel(data, releaseYear) {
  if (!data || !releaseYear) {
    setHTML('panel-history-body', '<p class="no-data">No historical events found for this period.</p>');
    return;
  }

  // Filter the week-wide pool to the release year only.
  // If nothing matched, widen to ±2 years so the panel is never empty.
  const forYear = (arr, y) => (arr ?? []).filter(e => e.year === y);
  const forRange = (arr, y, r) => (arr ?? []).filter(e => Math.abs(e.year - y) <= r);

  let eventItems = forYear(data.events, releaseYear);
  if (!eventItems.length) eventItems = forRange(data.events, releaseYear, 2);

  let birthItems = forYear(data.births, releaseYear).map(e => ({ ...e, text: `Born: ${e.text}` }));
  if (!birthItems.length) birthItems = forRange(data.births, releaseYear, 2).slice(0, 1)
    .map(e => ({ ...e, text: `Born: ${e.text}` }));

  let deathItems = forYear(data.deaths, releaseYear).map(e => ({ ...e, text: `Died: ${e.text}` }));
  if (!deathItems.length) deathItems = forRange(data.deaths, releaseYear, 2).slice(0, 1)
    .map(e => ({ ...e, text: `Died: ${e.text}` }));

  // Events get priority (3 slots); births/deaths fill remaining space.
  const events = [
    ...eventItems.slice(0, 3),
    ...birthItems.slice(0, 1),
    ...deathItems.slice(0, 1),
  ].slice(0, 4);

  if (!events.length) {
    setHTML('panel-history-body', '<p class="no-data">No historical events found for this period.</p>');
    return;
  }

  const html = events.map(event => `
    <div class="history-event">
      <div class="history-year">${escHtml(String(event.year))}</div>
      <div class="history-text">${escHtml(event.text)}</div>
    </div>`).join('');

  setHTML('panel-history-body', html);
}

function renderConcurrentPanel(data, currentTitle, artistName, maxItems = 8) {
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
  // Sort by MusicBrainz score descending — higher score = more prominent release
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, maxItems);

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
    const tvUrl   = show.url ?? '';
    const showName = escHtml(show.name ?? ep.name);
    const titleHtml = tvUrl
      ? `<a class="media-link" href="${escHtml(tvUrl)}" target="_blank" rel="noopener">${showName}</a>`
      : showName;
    const imgHtml = img
      ? `<img class="item-poster" src="${escHtml(img)}" alt="" onerror="this.style.display='none'">`
      : '';
    const wrappedImg = imgHtml && tvUrl
      ? `<a href="${escHtml(tvUrl)}" target="_blank" rel="noopener">${imgHtml}</a>`
      : imgHtml;
    return `
      <div class="tv-item">
        ${wrappedImg}
        <div class="tv-info">
          <div class="tv-title">${titleHtml}</div>
          ${network ? `<div class="tv-network">${escHtml(network)}</div>` : ''}
          ${genres  ? `<div class="tv-genre">${escHtml(genres)}</div>`   : ''}
          ${airdate ? `<div class="tv-date">${escHtml(airdate)}</div>`   : ''}
        </div>
      </div>`;
  }).join('');

  setHTML('panel-tv-body', html);
}

function renderMoviePanel(data) {
  if (!Array.isArray(data) || !data.length) {
    setHTML('panel-movies-body', '<p class="no-data">No movies found for this date.</p>');
    return;
  }

  const html = data.map(m => {
    const dateStr   = m.date ? formatDate(m.date) : '';
    const titleHtml = `<a class="media-link" href="${escHtml(m.tmdbUrl)}" target="_blank" rel="noopener">${escHtml(m.title)}</a>`;
    const imgHtml   = m.posterUrl
      ? `<img class="item-poster" src="${escHtml(m.posterUrl)}" alt="" onerror="this.style.display='none'">`
      : '';
    const wrappedImg = imgHtml
      ? `<a href="${escHtml(m.tmdbUrl)}" target="_blank" rel="noopener">${imgHtml}</a>`
      : '';

    const directors = m.directors?.length ? `<div class="movie-director">dir. ${escHtml(m.directors.join(', '))}</div>` : '';
    const writers   = m.writers?.length   ? `<div class="movie-writer">writ. ${escHtml(m.writers.join(', '))}</div>`   : '';

    return `
      <div class="movie-item">
        ${wrappedImg}
        <div class="movie-info">
          <div class="movie-title">${titleHtml}</div>
          ${directors}
          ${writers}
          ${dateStr ? `<div class="movie-date">${escHtml(dateStr)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  setHTML('panel-movies-body', html || '<p class="no-data">No movies found for this date.</p>');
}

function renderArtistPanel(mbData, wikiData) {
  let html = '';

  const name = wikiData?.title ?? mbData?.name ?? '';
  const area = mbData?.area?.name ?? mbData?.['begin-area']?.name ?? '';
  const began = mbData?.['life-span']?.begin?.split('-')[0] ?? '';

  if (wikiData?.thumbnail?.source) {
    html += `<img class="artist-photo" src="${escHtml(wikiData.thumbnail.source)}" alt="" onerror="this.style.display='none'">`;
  }

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

function renderDateHeader(year, month, day) {
  const pad = n => String(n).padStart(2, '0');
  const dateStr = formatDate(`${year}-${pad(month)}-${pad(day)}`);
  el('song-header').innerHTML = `
    <div class="song-header">
      <div class="song-header-title">${escHtml(dateStr)}</div>
      <div class="song-header-artist">Explore this date in history</div>
    </div>`;
}

function resetPanelsForDate() {
  el('panel-song-wrap').hidden   = true;
  el('panel-artist-wrap').hidden = true;
  el('panel-history-title').textContent    = 'ON THIS WEEK IN HISTORY';
  el('panel-concurrent-title').textContent = 'MUSIC THIS WEEK';
  ['panel-history-body', 'panel-concurrent-body', 'panel-tv-body', 'panel-movies-body'].forEach(id => {
    setHTML(id, '<div class="loading">Loading…</div>');
  });
  initProgress(4);
}

async function selectDate(year, month, day) {
  hide('picker-section');
  show('results-section');
  resetPanelsForDate();
  renderDateHeader(year, month, day);
  el('results-section').scrollIntoView({ behavior: 'smooth' });

  getThisWeekInHistory(year, month, day)
    .then(d => { renderHistoryPanel(d, year);         tickProgress(); });
  getConcurrentReleases(year, month, day)
    .then(d => { renderConcurrentPanel(d, '', '', 16); tickProgress(); });
  getTVPremieres(year, month, day)
    .then(d => { renderTVPanel(d);                    tickProgress(); });
  getMovieReleases(year, month, day)
    .then(d => { renderMoviePanel(d);                 tickProgress(); });
}

function resetPanels() {
  el('panel-song-wrap').hidden   = false;
  el('panel-artist-wrap').hidden = false;
  el('panel-history-title').textContent    = 'ON THIS WEEK IN HISTORY';
  el('panel-concurrent-title').textContent = 'WHAT ELSE DROPPED';
  ['panel-song-body', 'panel-history-body', 'panel-concurrent-body', 'panel-artist-body', 'panel-tv-body', 'panel-movies-body'].forEach(id => {
    setHTML(id, '<div class="loading">Loading…</div>');
  });
  initProgress(6);
}

async function selectRecording(rec) {
  const title      = rec.title;
  const credit     = rec['artist-credit']?.[0];
  const artistName = credit?.artist?.name ?? 'Unknown';
  const artistId   = credit?.artist?.id ?? null;

  hide('picker-section');
  show('results-section');
  resetPanels();
  el('panel-song-title').textContent = 'THE SONG';
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
    .then(d => { renderSongPanel(rec, release, d); tickProgress(); });

  if (date?.year && date?.month && date?.day) {
    getThisWeekInHistory(date.year, date.month, date.day)
      .then(d => { renderHistoryPanel(d, date.year); tickProgress(); });
  } else {
    renderHistoryPanel(null, 0);
    tickProgress();
  }

  if (hasFullDate) {
    getConcurrentReleases(date.year, date.month, date.day)
      .then(d => { renderConcurrentPanel(d, title, artistName); tickProgress(); });
    getTVPremieres(date.year, date.month, date.day)
      .then(d => { renderTVPanel(d);                             tickProgress(); });
    getMovieReleases(date.year, date.month, date.day)
      .then(d => { renderMoviePanel(d);                          tickProgress(); });
  } else {
    renderConcurrentPanel(null, title, artistName);
    renderTVPanel(null);
    renderMoviePanel(null);
    tickProgress(); tickProgress(); tickProgress();
  }

  // Artist panel needs both MB + Wikipedia; wait for both together
  Promise.all([
    artistId ? getArtistDetails(artistId) : Promise.resolve(null),
    getWikiSummary(artistName),
  ]).then(([artistMb, artistWiki]) => {
    renderArtistPanel(artistMb, artistWiki?.type === 'disambiguation' ? null : artistWiki);
    tickProgress();
  });
}

async function selectReleaseGroup(rg) {
  const credit     = rg['artist-credit']?.[0];
  const artistName = credit?.artist?.name ?? 'Unknown';
  const artistId   = credit?.artist?.id ?? null;
  const date       = parseDate(rg['first-release-date']);

  hide('picker-section');
  show('results-section');
  resetPanels();
  el('panel-song-title').textContent = 'THE ALBUM';
  el('results-section').scrollIntoView({ behavior: 'smooth' });

  el('song-header').innerHTML = `
    <div class="song-header">
      <div class="song-header-title">${escHtml(rg.title)}</div>
      <div class="song-header-artist">${escHtml(artistName)}</div>
      ${date?.raw ? `<div class="song-header-date">Released ${escHtml(formatDate(date.raw))}</div>` : ''}
    </div>`;

  const hasFullDate = date?.year && date?.month && date?.day;

  getAlbumWiki(rg.title, artistName)
    .then(d => { renderAlbumPanel(rg, d); tickProgress(); });

  if (date?.year && date?.month && date?.day) {
    getThisWeekInHistory(date.year, date.month, date.day)
      .then(d => { renderHistoryPanel(d, date.year); tickProgress(); });
  } else {
    renderHistoryPanel(null, 0);
    tickProgress();
  }

  if (hasFullDate) {
    getConcurrentReleases(date.year, date.month, date.day)
      .then(d => { renderConcurrentPanel(d, rg.title, artistName); tickProgress(); });
    getTVPremieres(date.year, date.month, date.day)
      .then(d => { renderTVPanel(d);                                tickProgress(); });
    getMovieReleases(date.year, date.month, date.day)
      .then(d => { renderMoviePanel(d);                             tickProgress(); });
  } else {
    renderConcurrentPanel(null, rg.title, artistName);
    renderTVPanel(null);
    renderMoviePanel(null);
    tickProgress(); tickProgress(); tickProgress();
  }

  Promise.all([
    artistId ? getArtistDetails(artistId) : Promise.resolve(null),
    getWikiSummary(artistName),
  ]).then(([artistMb, artistWiki]) => {
    renderArtistPanel(artistMb, artistWiki?.type === 'disambiguation' ? null : artistWiki);
    tickProgress();
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
  el('picker-title').textContent = 'SELECT A SONG';
  setHTML('picker-list', '<div class="loading">Searching…</div>');
  el('picker-section').scrollIntoView({ behavior: 'smooth' });

  const data = await searchRecordings(title, artist);
  renderPicker(data?.recordings ?? []);
});

el('album-form').addEventListener('submit', async e => {
  e.preventDefault();

  const title  = el('album-input').value.trim();
  const artist = el('album-artist-input').value.trim();
  if (!title) return;

  hide('results-section');
  show('picker-section');
  el('picker-title').textContent = 'SELECT AN ALBUM';
  setHTML('picker-list', '<div class="loading">Searching…</div>');
  el('picker-section').scrollIntoView({ behavior: 'smooth' });

  const data = await searchReleaseGroups(title, artist);
  renderAlbumPicker(data?.['release-groups'] ?? []);
});

el('back-btn').addEventListener('click', goToSearch);
el('new-search-btn').addEventListener('click', goToSearch);

function switchTab(active) {
  ['song', 'album', 'date'].forEach(t => {
    el(`tab-${t}`).classList.toggle('active', t === active);
  });
  el('search-form').hidden = active !== 'song';
  el('album-form').hidden  = active !== 'album';
  el('date-form').hidden   = active !== 'date';
}

el('tab-song').addEventListener('click',  () => switchTab('song'));
el('tab-album').addEventListener('click', () => switchTab('album'));
el('tab-date').addEventListener('click',  () => switchTab('date'));

function parseTextDate(str) {
  str = str.trim();
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  // YYYY-MM-DD or YYYY/MM/DD
  let m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };

  // Numeric: MM/DD/YY, DD/MM/YYYY, etc. — slash, dash, or dot, 2- or 4-digit year
  m = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    const a  = +m[1], b = +m[2];
    const yr = m[3].length === 2 ? (+m[3] <= 30 ? 2000 + +m[3] : 1900 + +m[3]) : +m[3];
    // Unambiguous: whichever part exceeds 12 must be the day
    if (b > 12) return { year: yr, month: a, day: b };  // M/D/Y  e.g. 9/22/88
    if (a > 12) return { year: yr, month: b, day: a };  // D/M/Y  e.g. 22/9/88
    return { year: yr, month: a, day: b };               // ambiguous → M/D/Y
  }

  // "14 June 1955"
  m = str.match(/^(\d{1,2})\s+([A-Za-z]+)[,\s]+(\d{4})$/);
  if (m) {
    const idx = MONTHS.findIndex(mn => m[2].toLowerCase().startsWith(mn));
    if (idx !== -1) return { year: +m[3], month: idx + 1, day: +m[1] };
  }

  // "June 14, 1955" or "June 14 1955"
  m = str.match(/^([A-Za-z]+)\s+(\d{1,2})[,\s]+(\d{4})$/);
  if (m) {
    const idx = MONTHS.findIndex(mn => m[1].toLowerCase().startsWith(mn));
    if (idx !== -1) return { year: +m[3], month: idx + 1, day: +m[2] };
  }

  // "June 1955" – no day, default to 1st
  m = str.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const idx = MONTHS.findIndex(mn => m[1].toLowerCase().startsWith(mn));
    if (idx !== -1) return { year: +m[2], month: idx + 1, day: 1 };
  }

  // bare year "1955"
  m = str.match(/^(\d{4})$/);
  if (m) return { year: +m[1], month: 1, day: 1 };

  return null;
}

el('date-input').addEventListener('input', () => el('date-input').setCustomValidity(''));

el('date-form').addEventListener('submit', e => {
  e.preventDefault();
  const val = el('date-input').value.trim();
  if (!val) return;
  const parsed = parseTextDate(val);
  if (!parsed) {
    el('date-input').setCustomValidity('Try "14 June 1955", "6/14/1955", or just "1955"');
    el('date-input').reportValidity();
    return;
  }
  el('date-input').setCustomValidity('');
  selectDate(parsed.year, parsed.month, parsed.day);
});
