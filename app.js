import * as GeoTIFF from 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm';

const UPSTREAM = 'https://storage.googleapis.com/climate-and-sustainability/gem-15/';
// The plain bucket URLs send no CORS headers; the JSON API media endpoint does (incl. Range).
const API = 'https://storage.googleapis.com/storage/v1/b/climate-and-sustainability/o/';
const corsUrl = (path) => `${API}${encodeURIComponent('gem-15/' + path)}?alt=media`;

const TILE = 256;
const MIN_DATA_ZOOM = 7;
const MAX_READ = 512;
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
function getItem(lon, lat) {
  const cell = cellName(lon, lat);
  if (!itemCache.has(cell)) {
    const url = corsUrl(`stac/gem-15/${groupName(lon, lat)}/${cell}/${cell}.json`);
    itemCache.set(
      cell,
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
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
        const tiff = await GeoTIFF.fromUrl(url);
        const count = await tiff.getImageCount();
        const images = [];
        for (let i = 0; i < count; i++) {
          const img = await tiff.getImage(i);
          images.push({ img, w: img.getWidth(), h: img.getHeight() });
        }
        return images;
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
    (best, im) => (BASE_RES * (full.w / im.w) <= mPerPx && im.w < best.w ? im : best),
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

  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  const outW = Math.min(ww, MAX_READ);
  const outH = Math.min(wh, MAX_READ);
  const opts = { window: [wx0, wy0, wx1, wy1], samples: [0], interleave: false };
  if (outW !== ww || outH !== wh) Object.assign(opts, { width: outW, height: outH, resampleMethod: 'nearest' });
  const rasters = await pick.img.readRasters(opts);
  return {
    data: rasters[0], proj, t, outW, outH, ww, wh, wx0, wy0,
    sx: pick.w / full.w, sy: pick.h / full.h,
  };
}

const COS = Math.cos(Math.PI / 4);
const LIGHT = [-0.5, 0.5, COS];

async function renderTile(layer, shade, z, x, y) {
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
          readCell(lon, lat, layer, ext, mPerPx)
            .then((c) => c && cells.set(`${lon},${lat}`, c))
            .catch((e) => console.warn('cell failed', lon, lat, e)),
        );
      }
    }
    await Promise.all(jobs);

    if (cells.size) {
      for (let j = 0; j < N; j++) {
        const lat = tileLat(y + (j - 0.5) / TILE, z);
        const latCell = Math.floor(lat);
        for (let i = 0; i < N; i++) {
          const lon = tileLon(x + (i - 0.5) / TILE, z);
          const cell = cells.get(`${Math.floor(lon)},${latCell}`);
          if (!cell) continue;
          const [ux, uy] = cell.proj.forward([lon, lat]);
          const c = ((ux - cell.t[2]) / cell.t[0]) * cell.sx - cell.wx0;
          const r = ((uy - cell.t[5]) / cell.t[4]) * cell.sy - cell.wy0;
          if (c < 0 || r < 0 || c >= cell.ww || r >= cell.wh) continue;
          const cc = Math.floor((c * cell.outW) / cell.ww);
          const rr = Math.floor((r * cell.outH) / cell.wh);
          elev[j * N + i] = cell.data[rr * cell.outW + cc];
        }
      }
    }
    elev.mPerPx = mPerPx;
  }

  const img = new ImageData(TILE, TILE);
  const px = img.data;
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
function setStatus() {
  statusEl.textContent = pending
    ? `Loading ${pending} tile${pending > 1 ? 's' : ''}...`
    : map.getZoom() < MIN_DATA_ZOOM
      ? `Zoom in to level ${MIN_DATA_ZOOM} or higher to load data.`
      : 'Data: GEM-15 (Google), CC-BY-4.0';
}

maplibregl.addProtocol('gem', async (params) => {
  const [layer, shade, z, x, y] = params.url.replace('gem://', '').split('/');
  pending++;
  setStatus();
  try {
    return { data: await renderTile(layer, shade === '1', +z, +x, +y) };
  } catch (e) {
    console.error('tile failed', params.url, e);
    throw e;
  } finally {
    pending--;
    setStatus();
  }
});

const tileUrl = () => {
  const layer = document.querySelector('input[name=layer]:checked').value;
  const shade = document.getElementById('shade').checked ? 1 : 0;
  return `gem://${layer}/${shade}/{z}/{x}/{y}`;
};

const map = new maplibregl.Map({
  container: 'map',
  hash: true,
  center: [10.5, 46.5],
  zoom: 9,
  maxZoom: 15,
  style: {
    version: 8,
    sources: {
      gem: { type: 'raster', tiles: [tileUrl()], tileSize: TILE, minzoom: MIN_DATA_ZOOM, maxzoom: 13, attribution: 'GEM-15 &copy; Google, CC-BY-4.0' },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': OCEAN } },
      { id: 'gem', type: 'raster', source: 'gem', paint: { 'raster-fade-duration': 0 } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl());
map.addControl(new maplibregl.ScaleControl());
map.on('zoom', setStatus);

function refresh() {
  map.getSource('gem').setTiles([tileUrl()]);
}
document.querySelectorAll('input[name=layer]').forEach((el) => el.addEventListener('change', refresh));
document.getElementById('shade').addEventListener('change', refresh);

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
