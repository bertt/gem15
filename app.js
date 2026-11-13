import * as GeoTIFF from 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm';

const UPSTREAM = 'https://storage.googleapis.com/climate-and-sustainability/gem-15/';
// The plain bucket URLs send no CORS headers; the JSON API media endpoint does (incl. Range).
const API = 'https://storage.googleapis.com/storage/v1/b/climate-and-sustainability/o/';
const corsUrl = (path) => `${API}${encodeURIComponent('gem-15/' + path)}?alt=media`;

const TILE = 256;
const MIN_DATA_ZOOM = 7;
const CHUNK_BITS = 8;
const DEM_MAX_ZOOM = 11; // terrain needs less detail than the colour layer
const LEVEL_TOLERANCE = 1.25; // accept an overview up to 25% coarser than the screen resolution
const CHUNK = 1 << CHUNK_BITS;
const G = 16; // reprojection grid intervals per tile
const DEBUG_TIMING = new URLSearchParams(location.search).has('timing');
const BASE_RES = 15;

// Hypsometric tint: lowland green -> yellow -> orange -> brown -> snow.
const STOPS = [
  [-400, '#3f8f6a'], [0, '#7fbf6a'], [200, '#b7d67f'], [500, '#e4e29a'], [1000, '#f2dca0'],
  [1500, '#e9c27f'], [2500, '#d99a5b'], [3500, '#b8703f'], [5000, '#8c4a2b'], [7000, '#e8dcd0'],
  [8800, '#ffffff'],
];
const OCEAN = '#a9d6ee';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const LUT_MIN = STOPS[0][0];
const LUT_MAX = STOPS[STOPS.length - 1][0];
const LUT = (() => {
  const n = 2048;
  const lut = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const v = LUT_MIN + ((LUT_MAX - LUT_MIN) * i) / (n - 1);
    let k = 0;
    while (k < STOPS.length - 2 && v > STOPS[k + 1][0]) k++;
    const [a, ca] = STOPS[k];
    const [b, cb] = STOPS[k + 1];
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    const A = hex(ca);
    const B = hex(cb);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = A[c] + (B[c] - A[c]) * t;
  }
  return lut;
})();

// ---- Legend ----
(() => {
  const step = 100 / (STOPS.length - 1);
  document.getElementById('ramp').style.background =
    'linear-gradient(to right, ' + STOPS.map((s, i) => `${s[1]} ${(i * step).toFixed(1)}%`).join(', ') + ')';
  const ticks = document.getElementById('ticks');
  STOPS.forEach((s, i) => {
    if (i % 2) return;
    const el = document.createElement('span');
    el.style.left = `${i * step}%`;
    el.textContent = s[0];
    ticks.appendChild(el);
  });
})();

// ---- Projection helpers ----
const projCache = new Map();
function utm(epsg) {
  let p = projCache.get(epsg);
  if (!p) {
    const zone = epsg % 100;
    const south = epsg >= 32700 ? ' +south' : '';
    p = proj4('EPSG:4326', `+proj=utm +zone=${zone}${south} +datum=WGS84 +units=m +no_defs`);
    projCache.set(epsg, p);
  }
  return p;
}

const fmt = (n) => (n < 0 ? 'm' + -n : String(n));
const gfmt = (n) => (n < 0 ? 'm' + -n : 'p' + n);
const cellName = (lon, lat) => `w${fmt(lon)}s${fmt(lat)}`;
const groupName = (lon, lat) => `${gfmt(Math.floor(lat / 10) * 10)}_${gfmt(Math.floor(lon / 10) * 10)}`;

// ---- STAC + COG caches ----
const itemCache = new Map();
const groupCache = new Map();
// Lists which cells exist in a group, so no requests are made for cells without data (404s).
function getGroupCells(group) {
  if (!groupCache.has(group)) {
    const base = `gem-15/stac/gem-15/${group}/`;
    groupCache.set(
      group,
      (async () => {
        const cells = new Set();
        let token = '';
        do {
          const url = `${API}?prefix=${encodeURIComponent(base)}&delimiter=/&fields=prefixes,nextPageToken` +
            (token ? `&pageToken=${encodeURIComponent(token)}` : '');
          const r = await fetch(url);
          if (!r.ok) throw new Error(`list ${group}: ${r.status}`);
          const j = await r.json();
          (j.prefixes || []).forEach((p) => cells.add(p.slice(base.length, -1)));
          token = j.nextPageToken || '';
        } while (token);
        return cells;
      })().catch((e) => {
        groupCache.delete(group);
        throw e;
      }),
    );
  }
  return groupCache.get(group);
}

function getItem(lon, lat) {
  const cell = cellName(lon, lat);
  if (!itemCache.has(cell)) {
    const ts = performance.now();
    const group = groupName(lon, lat);
    const url = corsUrl(`stac/gem-15/${group}/${cell}/${cell}.json`);
    itemCache.set(
      cell,
      getGroupCells(group)
        .then((cells) => (cells.has(cell) ? fetch(url) : null))
        .then((r) => (r && r.ok ? r.json() : null))
        .then((j) => {
          if (DEBUG_TIMING) console.debug(`stac ${cell}: ${(performance.now() - ts).toFixed(0)}ms`);
          return j;
        })
        .catch(() => null),
    );
  }
  return itemCache.get(cell);
}

const tiffCache = new Map();
function getImages(href) {
  const url = corsUrl(href.replace(UPSTREAM, ''));
  if (!tiffCache.has(url)) {
    tiffCache.set(
      url,
      (async () => {
        const th = performance.now();
        const tiff = await GeoTIFF.fromUrl(url, { blockSize: 256 * 1024, cacheSize: 200 });
        const count = await tiff.getImageCount();
        const imgs = await Promise.all(Array.from({ length: count }, (_, i) => tiff.getImage(i)));
        if (DEBUG_TIMING) console.debug(`header ${url.slice(-40)}: ${count} levels, ${(performance.now() - th).toFixed(0)}ms`);
        return imgs.map((img) => ({ img, w: img.getWidth(), h: img.getHeight() }));
      })().catch((e) => {
        tiffCache.delete(url);
        throw e;
      }),
    );
  }
  return tiffCache.get(url);
}

// ---- Tile math ----
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// Reads the part of one 1x1 degree cell needed for the given lon/lat extent.
async function readCell(lon, lat, layer, ext, mPerPx) {
  const item = await getItem(lon, lat);
  const asset = item && item.assets && item.assets[layer];
  if (!asset) return null;
  const epsg = asset['proj:epsg'];
  const t = asset['proj:transform'];
  const images = await getImages(asset.href);
  const full = images[0];

  // Coarsest image whose pixels are still finer than the screen resolution.
  const pick = images.reduce(
    (best, im) => (BASE_RES * (full.w / im.w) <= mPerPx * LEVEL_TOLERANCE && im.w < best.w ? im : best),
    full,
  );

  const proj = utm(epsg);
  const x0 = Math.max(ext.west, lon);
  const x1 = Math.min(ext.east, lon + 1);
  const y0 = Math.max(ext.south, lat);
  const y1 = Math.min(ext.north, lat + 1);
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const [ux, uy] = proj.forward([x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * j) / 4]);
      const c = ((ux - t[2]) / t[0]) * (pick.w / full.w);
      const r = ((uy - t[5]) / t[4]) * (pick.h / full.h);
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    }
  }
  const wx0 = Math.max(0, Math.floor(minC) - 2);
  const wy0 = Math.max(0, Math.floor(minR) - 2);
  const wx1 = Math.min(pick.w, Math.ceil(maxC) + 2);
  const wy1 = Math.min(pick.h, Math.ceil(maxR) + 2);
  if (wx1 <= wx0 || wy1 <= wy0) return null;

  const cx0 = Math.floor(wx0 / CHUNK), cx1 = Math.floor((wx1 - 1) / CHUNK);
  const cy0 = Math.floor(wy0 / CHUNK), cy1 = Math.floor((wy1 - 1) / CHUNK);
  const level = images.indexOf(pick);
  const chunks = new Map();
  const reads = [];
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      reads.push(getChunk(asset.href, level, pick, cx, cy).then((ch) => chunks.set(cx + ',' + cy, ch)));
    }
  }
  await Promise.all(reads);
  return { chunks, proj, t, w: pick.w, h: pick.h, sx: pick.w / full.w, sy: pick.h / full.h };
}

// Aligned chunks are shared between tiles, so neighbouring tiles don't each issue their own reads.
const chunkCache = new Map();
const MAX_CHUNKS = 200;
// Decompresses COG blocks in web workers instead of on the main thread.
const decodePool = new GeoTIFF.Pool(Math.min(4, navigator.hardwareConcurrency || 2));
function getChunk(href, level, pick, cx, cy) {
  const key = `${href}|${level}|${cx},${cy}`;
  let p = chunkCache.get(key);
  if (p) {
    chunkCache.delete(key); // refresh LRU position
  } else {
    const tc = performance.now();
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    const x1 = Math.min(pick.w, x0 + CHUNK), y1 = Math.min(pick.h, y0 + CHUNK);
    p = withRetry(() => pick.img.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: false, pool: decodePool })).then(
      (r) => {
        if (DEBUG_TIMING) console.debug(`chunk L${level} ${cx},${cy}: ${(performance.now() - tc).toFixed(0)}ms, ${r[0].byteLength} B decoded`);
        return { data: r[0], w: x1 - x0 };
      },
    );
    p.catch(() => chunkCache.delete(key));
    if (chunkCache.size >= MAX_CHUNKS) chunkCache.delete(chunkCache.keys().next().value);
  }
  chunkCache.set(key, p);
  return p;
}

function cellValue(cell, c, r) {
  const ch = cell.chunks.get((c >> CHUNK_BITS) + ',' + (r >> CHUNK_BITS));
  return ch ? ch.data[(r & (CHUNK - 1)) * ch.w + (c & (CHUNK - 1))] : NaN;
}

// Range requests fail transiently (rate limits, dropped connections); retry with backoff.
async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
}

const COS = Math.cos(Math.PI / 4);
const LIGHT = [-0.5, 0.5, COS];

async function renderTile(layer, shade, z, x, y, dem = false) {
  const t0 = performance.now();
  const N = TILE + 2; // 1 px margin for hillshade gradients
  const elev = new Float32Array(N * N).fill(NaN);
  if (z >= MIN_DATA_ZOOM) {
    const n = 2 ** z;
    const west = tileLon(x - 1 / TILE, z);
    const east = tileLon(x + 1 + 1 / TILE, z);
    const north = tileLat(y - 1 / TILE, z);
    const south = tileLat(y + 1 + 1 / TILE, z);
    const ext = { west, east, north, south };
    const mPerPx = (40075016.686 * Math.cos((((north + south) / 2) * Math.PI) / 180)) / (n * TILE);

    const cells = new Map();
    const jobs = [];
    for (let lon = Math.floor(west); lon <= Math.floor(east); lon++) {
      for (let lat = Math.floor(south); lat <= Math.floor(north); lat++) {
        jobs.push(
          withRetry(() => readCell(lon, lat, layer, ext, mPerPx))
            .then((c) => c && cells.set(`${lon},${lat}`, c))
            .catch((e) => console.warn('cell failed', lon, lat, e)),
        );
      }
    }
    await Promise.all(jobs);

    const tFetch = performance.now();
    if (cells.size) {
      const lons = new Float64Array(N);
      for (let i = 0; i < N; i++) lons[i] = tileLon(x + (i - 0.5) / TILE, z);
      // Run proj4 only on a coarse (G+1)^2 grid per cell and interpolate bilinearly in between.
      for (const cell of cells.values()) {
        const gc = new Float64Array((G + 1) * (G + 1));
        const gr = new Float64Array((G + 1) * (G + 1));
        for (let gj = 0; gj <= G; gj++) {
          const lat = tileLat(y + ((gj * (N - 1)) / G - 0.5) / TILE, z);
          for (let gi = 0; gi <= G; gi++) {
            const lon = tileLon(x + ((gi * (N - 1)) / G - 0.5) / TILE, z);
            const [ux, uy] = cell.proj.forward([lon, lat]);
            gc[gj * (G + 1) + gi] = ((ux - cell.t[2]) / cell.t[0]) * cell.sx;
            gr[gj * (G + 1) + gi] = ((uy - cell.t[5]) / cell.t[4]) * cell.sy;
          }
        }
        cell.gc = gc;
        cell.gr = gr;
      }
      for (let j = 0; j < N; j++) {
        const lat = tileLat(y + (j - 0.5) / TILE, z);
        const latCell = Math.floor(lat);
        const v = (j * G) / (N - 1);
        const gj = Math.min(G - 1, Math.floor(v));
        const fy = v - gj;
        for (let i = 0; i < N; i++) {
          const lon = lons[i];
          const cell = cells.get(`${Math.floor(lon)},${latCell}`);
          if (!cell) continue;
          const u = (i * G) / (N - 1);
          const gi = Math.min(G - 1, Math.floor(u));
          const fx = u - gi;
          const k0 = gj * (G + 1) + gi;
          const k1 = k0 + G + 1;
          const c = (cell.gc[k0] * (1 - fx) + cell.gc[k0 + 1] * fx) * (1 - fy) + (cell.gc[k1] * (1 - fx) + cell.gc[k1 + 1] * fx) * fy;
          const r = (cell.gr[k0] * (1 - fx) + cell.gr[k0 + 1] * fx) * (1 - fy) + (cell.gr[k1] * (1 - fx) + cell.gr[k1 + 1] * fx) * fy;
          if (c < 0 || r < 0 || c >= cell.w || r >= cell.h) continue;
          elev[j * N + i] = cellValue(cell, Math.floor(c), Math.floor(r));
        }
      }
    }
    elev.mPerPx = mPerPx;
    if (DEBUG_TIMING) console.debug(`tile ${z}/${x}/${y}: fetch ${(tFetch - t0).toFixed(0)}ms, sample ${(performance.now() - tFetch).toFixed(0)}ms`);
  }

  const img = new ImageData(TILE, TILE);
  const px = img.data;
  if (dem) {
    // Terrarium encoding: height = (R*256 + G + B/256) - 32768
    for (let j = 0; j < TILE; j++) {
      for (let i = 0; i < TILE; i++) {
        let e = elev[(j + 1) * N + i + 1];
        if (!(e === e)) e = 0;
        const v = Math.min(65535, Math.max(0, e + 32768));
        const o = (j * TILE + i) * 4;
        px[o] = Math.floor(v / 256);
        px[o + 1] = Math.floor(v) % 256;
        px[o + 2] = Math.floor((v - Math.floor(v)) * 256);
        px[o + 3] = 255;
      }
    }
    const cv = new OffscreenCanvas(TILE, TILE);
    cv.getContext('2d').putImageData(img, 0, 0);
    return (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }
  const mPerPx = elev.mPerPx || 1;
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const k = (j + 1) * N + i + 1;
      const e = elev[k];
      if (!(e === e) || e < -1000 || e > 10000) continue;
      const li = Math.min(LUT.length / 3 - 1, Math.max(0, Math.round(((e - LUT_MIN) / (LUT_MAX - LUT_MIN)) * (LUT.length / 3 - 1))));
      let f = 1;
      if (shade) {
        const l = elev[k - 1], r = elev[k + 1], u = elev[k - N], d = elev[k + N];
        const dzde = ((r === r ? r : e) - (l === l ? l : e)) / (2 * mPerPx);
        const dzdn = ((u === u ? u : e) - (d === d ? d : e)) / (2 * mPerPx);
        const ex = 2;
        const len = Math.hypot(dzde * ex, dzdn * ex, 1);
        const dot = (-dzde * ex * LIGHT[0] - dzdn * ex * LIGHT[1] + LIGHT[2]) / len;
        f = Math.min(1.3, Math.max(0.55, 0.65 + 0.35 * (dot / COS)));
      }
      const o = (j * TILE + i) * 4;
      px[o] = LUT[li * 3] * f;
      px[o + 1] = LUT[li * 3 + 1] * f;
      px[o + 2] = LUT[li * 3 + 2] * f;
      px[o + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext('2d').putImageData(img, 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

// ---- Map ----
let pending = 0;
const statusEl = document.getElementById('status');
let noData = false;
function setStatus() {
  const base = pending
    ? `Loading ${pending} tile${pending > 1 ? 's' : ''}...`
    : map.getZoom() < MIN_DATA_ZOOM
      ? `Zoom in to level ${MIN_DATA_ZOOM} or higher to load data.`
      : noData
        ? 'No elevation data here (open water or outside GEM-15 coverage).'
        : 'Data: GEM-15 (Google), CC-BY-4.0';
  statusEl.textContent = `Zoom ${map.getZoom().toFixed(1)} · ${base}`;
}

async function checkCoverage() {
  if (map.getZoom() < MIN_DATA_ZOOM) noData = false;
  else {
    const c = map.getCenter();
    noData = !(await getItem(Math.floor(c.lng), Math.floor(c.lat)));
  }
  setStatus();
}

const gemProtocol = async (params) => {
  const dem = params.url.startsWith('gemdem://');
  const [layer, shade, z, x, y] = params.url.replace(/^gem(dem)?:\/\//, '').split('/');
  pending++;
  setStatus();
  try {
    return { data: await renderTile(layer, shade === '1', +z, +x, +y, dem) };
  } catch (e) {
    console.error('tile failed', params.url, e);
    throw e;
  } finally {
    pending--;
    setStatus();
  }
};
maplibregl.addProtocol('gem', gemProtocol);
maplibregl.addProtocol('gemdem', gemProtocol);

const demUrl = () => `gemdem://${document.querySelector('input[name=layer]:checked').value}/0/{z}/{x}/{y}`;

const tileUrl = () => {
  const layer = document.querySelector('input[name=layer]:checked').value;
  const shade = document.getElementById('shade').checked ? 1 : 0;
  return `gem://${layer}/${shade}/{z}/{x}/{y}`;
};

const map = new maplibregl.Map({
  container: 'map',
  hash: true,
  center: [7.6586, 45.9763],
  zoom: 12.6,
  pitch: 0,
  bearing: 0,
  maxPitch: 85,
  maxZoom: 15,
  style: {
    version: 8,
    sources: {
      dem: { type: 'raster-dem', tiles: [demUrl()], tileSize: TILE, encoding: 'terrarium', minzoom: MIN_DATA_ZOOM, maxzoom: DEM_MAX_ZOOM },
      gem: { type: 'raster', tiles: [tileUrl()], tileSize: TILE, minzoom: MIN_DATA_ZOOM, maxzoom: 13, attribution: 'GEM-15 &copy; Google, CC-BY-4.0' },
      countries: {
        type: 'geojson',
        data: 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_0_countries.geojson',
        attribution: 'Borders &copy; Natural Earth',
      },
      cities: {
        type: 'geojson',
        data: 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_10m_populated_places_simple.geojson',
      },
    },
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': OCEAN } },
      {
        id: 'countries-fill',
        type: 'fill',
        source: 'countries',
        paint: { 'fill-color': '#cfcabb' },
      },
      { id: 'gem', type: 'raster', source: 'gem', paint: { 'raster-fade-duration': 0 } },
      {
        id: 'countries-outline',
        type: 'line',
        source: 'countries',
        paint: {
          'line-color': '#444',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.9, 10, 0.5],
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 8, 1.2],
        },
      },
      {
        id: 'cities',
        type: 'symbol',
        source: 'cities',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 12,
          'text-anchor': 'top',
          'text-offset': [0, 0.5],
          'text-optional': true,
          'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'pop_max'], 0]],
          'icon-allow-overlap': true,
        },
        paint: {
          'text-color': '#222',
          'text-halo-color': 'rgba(255,255,255,0.9)',
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'cities-dot',
        type: 'circle',
        source: 'cities',
        paint: {
          'circle-radius': 3,
          'circle-color': '#d32f2f',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1,
        },
      },
    ],
  },
});
const COLOUR_MAX_ZOOM = 13;
const zoomRangeEl = document.getElementById('zoomrange');
function updateZoomRange() {
  const terrain = document.getElementById('extrude').checked;
  const max = terrain ? DEM_MAX_ZOOM : COLOUR_MAX_ZOOM;
  const over = map.getZoom() > max;
  zoomRangeEl.textContent =
    `Available zoom levels: colour ${MIN_DATA_ZOOM}–${COLOUR_MAX_ZOOM}, terrain ${MIN_DATA_ZOOM}–${DEM_MAX_ZOOM}. ` +
    (over ? `Overzoomed (beyond ${max}).` : 'No overzoom.');
  zoomRangeEl.style.color = over ? '#c62828' : '#2e7d32';
  zoomRangeEl.style.fontWeight = 'bold';
}
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
map.addControl(new maplibregl.ScaleControl());
map.on('zoom', setStatus);
map.on('zoom', updateZoomRange);
document.getElementById('extrude').addEventListener('change', updateZoomRange);
updateZoomRange();
map.on('moveend', checkCoverage);
map.on('load', checkCoverage);

function refresh() {
  map.getSource('gem').setTiles([tileUrl()]);
  map.getSource('dem').setTiles([demUrl()]);
}
document.querySelectorAll('input[name=layer]').forEach((el) => el.addEventListener('change', refresh));
document.getElementById('shade').addEventListener('change', refresh);

// ---- 3D terrain / extrusion ----
const extrudeEl = document.getElementById('extrude');
const exagEl = document.getElementById('exag');
function applyTerrain() {
  map.setTerrain(extrudeEl.checked ? { source: 'dem', exaggeration: +exagEl.value } : null);
}
map.on('load', applyTerrain);
extrudeEl.addEventListener('change', applyTerrain);
exagEl.addEventListener('input', applyTerrain);

// ---- Click: elevation lookup at full 15 m resolution ----
async function elevationAt(lng, lat, layer) {
  const item = await getItem(Math.floor(lng), Math.floor(lat));
  const asset = item && item.assets && item.assets[layer];
  if (!asset) return null;
  const t = asset['proj:transform'];
  const [ux, uy] = utm(asset['proj:epsg']).forward([lng, lat]);
  const c = Math.floor((ux - t[2]) / t[0]);
  const r = Math.floor((uy - t[5]) / t[4]);
  const [w, h] = [asset['proj:shape'][1], asset['proj:shape'][0]];
  if (c < 0 || r < 0 || c >= w || r >= h) return null;
  const images = await getImages(asset.href);
  const data = await images[0].img.readRasters({ window: [c, r, c + 1, r + 1], samples: [0] });
  const v = data[0][0];
  return v === v ? v : null;
}

map.on('click', async (e) => {
  const { lng, lat } = e.lngLat;
  const layer = document.querySelector('input[name=layer]:checked').value;
  const popup = new maplibregl.Popup().setLngLat(e.lngLat).setHTML('Loading...').addTo(map);
  let text;
  if (map.getZoom() < MIN_DATA_ZOOM) {
    text = `Zoom in to level ${MIN_DATA_ZOOM}+ to query elevation.`;
  } else {
    try {
      const v = await elevationAt(lng, lat, layer);
      text = v === null ? 'No data' : `<b>${v.toFixed(1)} m</b> (${layer.toUpperCase()})`;
    } catch (err) {
      console.error(err);
      text = 'Failed to read elevation';
    }
  }
  popup.setHTML(`${text}<br><small>${lat.toFixed(5)}, ${lng.toFixed(5)}</small>`);
});
map.on('mousemove', () => (map.getCanvas().style.cursor = 'crosshair'));
