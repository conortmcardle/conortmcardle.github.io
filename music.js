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

// Lower score = more canonical. Prefer Album/Single with a full US date.
const RELEASE_TYPE_RANK = { 'Album': 0, 'Single': 1, 'EP': 2, 'Compilation': 3, 'Live': 4 };

function getBestRelease(releases) {
  if (!releases?.length) return null;

  const official = releases.filter(r => r.status === 'Official' || !r.status);
  const pool = official.length ? official : releases;

  const dated = pool.filter(r => r.date);
  if (!dated.length) return pool[0] ?? releases[0];

  const isFullDate = r => /^\d{4}-\d{2}-\d{2}$/.test(r.date);

  const scored = dated.map(r => {
    const type      = RELEASE_TYPE_RANK[r['release-group']?.['primary-type']] ?? 5;
    const fullDate  = isFullDate(r) ? 0 : 1;
    const us        = r.country === 'US' ? 0 : 1;
    return { r, score: type * 100 + fullDate * 10 + us };
  });

  scored.sort((a, b) => a.score - b.score || a.r.date.localeCompare(b.r.date));
  return scored[0].r;
}

// ── MusicBrainz API ───────────────────────────────────────────────────────────

async function searchRecordings(title, artist) {
  let q = `recording:"${title.replace(/"/g, '')}"`;
  if (artist) q += ` AND artist:"${artist.replace(/"/g, '')}"`;
  const path = `/recording?query=${encodeURIComponent(q)}&fmt=json&limit=20&inc=releases+artist-credits`;
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

// ── Wikipedia API ─────────────────────────────────────────────────────────────

async function getOnThisDay(month, day) {
  const pad = n => String(n).padStart(2, '0');
  return wikiFetch(`/feed/onthisday/events/${pad(month)}/${pad(day)}`);
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

  // Sort: canonical studio/single releases first (earliest best-release date)
  const sorted = [...recordings].sort((a, b) => {
    const da = getBestRelease(a.releases)?.date ?? '9999';
    const db = getBestRelease(b.releases)?.date ?? '9999';
    return da.localeCompare(db);
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
  const events = (data?.events ?? []).filter(e => e.year === releaseYear);

  if (!events.length) {
    const msg = releaseYear
      ? `No recorded events found for ${releaseYear} on this date.`
      : 'No historical events found for this date.';
    setHTML('panel-history-body', `<p class="no-data">${msg}</p>`);
    return;
  }

  const html = events.map(event => `
    <div class="history-event">
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
  ['panel-song-body', 'panel-history-body', 'panel-concurrent-body', 'panel-artist-body'].forEach(id => {
    setHTML(id, '<div class="loading">Loading…</div>');
  });
}

async function selectRecording(rec) {
  const title      = rec.title;
  const credit     = rec['artist-credit']?.[0];
  const artistName = credit?.artist?.name ?? 'Unknown';
  const artistId   = credit?.artist?.id ?? null;
  const release    = getBestRelease(rec.releases);
  const date       = parseDate(release?.date);

  hide('picker-section');
  show('results-section');
  resetPanels();
  renderSongHeader(title, artistName, release);

  el('results-section').scrollIntoView({ behavior: 'smooth' });

  // Fire all requests in parallel
  const [songWiki, historyData, concurrentData, artistMb, artistWiki] = await Promise.all([
    getSongWiki(title, artistName),
    date?.month && date?.day ? getOnThisDay(date.month, date.day) : Promise.resolve(null),
    date?.year && date?.month && date?.day ? getConcurrentReleases(date.year, date.month, date.day) : Promise.resolve(null),
    artistId ? getArtistDetails(artistId) : Promise.resolve(null),
    getWikiSummary(artistName),
  ]);

  renderSongPanel(rec, release, songWiki);
  renderHistoryPanel(historyData, date?.year ?? 0);
  renderConcurrentPanel(concurrentData, title, artistName);
  renderArtistPanel(
    artistMb,
    artistWiki?.type === 'disambiguation' ? null : artistWiki
  );
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
