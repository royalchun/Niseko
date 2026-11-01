// Live data from Open-Meteo (free, no key). Results are cached in localStorage
// so friends refreshing the page don't hammer the free API.
import { API, WEATHER_POINTS, SUMMIT, RESORTS } from './config.js';

const HOURLY = ['temperature_2m', 'precipitation', 'rain', 'snowfall', 'snow_depth', 'weather_code', 'cloud_cover', 'cloud_cover_low',
  'visibility', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'freezing_level_height', 'is_day'];

export const jst = t => Date.parse(t + ':00+09:00');

export async function cached(key, ttlMin, fn) {
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null');
    if (c && Date.now() - c.at < ttlMin * 60e3) return c.data;
  } catch { /* storage unavailable */ }
  const data = await fn();
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* quota */ }
  return data;
}

export async function getJSON(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.reason || `HTTP ${r.status}`);
  return j;
}

export const qs = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// Hourly series for summit + 4 resort bases, 14 days back and 16 days ahead.
export function fetchHourly() {
  return cached('nk-hourly-v1', 30, async () => {
    const pts = WEATHER_POINTS;
    const url = `${API.forecast}?${qs({
      latitude: pts.map(p => p.lat).join(','), longitude: pts.map(p => p.lon).join(','),
      elevation: pts.map(p => p.elevation).join(','),
      hourly: HOURLY.join(','), past_days: 14, forecast_days: 16, timezone: 'Asia/Tokyo',
    })}`;
    const res = await getJSON(url);
    const arr = Array.isArray(res) ? res : [res];
    const out = {};
    arr.forEach((r, i) => {
      const h = r.hourly;
      out[pts[i].id] = { elevation: r.elevation, time: h.time.map(jst), ...Object.fromEntries(HOURLY.map(k => [k, h[k]])) };
    });
    return out;
  });
}

// Daily snowfall from several independent models (multi-model blend input).
export const MODELS = [
  { id: 'jma_seamless', name: 'JMA (Japan)', weight: 0.3 },
  { id: 'ecmwf_ifs025', name: 'ECMWF IFS', weight: 0.3 },
  { id: 'icon_seamless', name: 'DWD ICON', weight: 0.2 },
  { id: 'gfs_seamless', name: 'NOAA GFS', weight: 0.2 },
];
export function fetchMultiModel() {
  return cached('nk-multimodel-v1', 60, async () => {
    const url = `${API.forecast}?${qs({
      latitude: SUMMIT.lat, longitude: SUMMIT.lon, elevation: 1100,
      daily: 'snowfall_sum,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max,precipitation_sum',
      models: MODELS.map(m => m.id).join(','), forecast_days: 16, past_days: 14, timezone: 'Asia/Tokyo',
    })}`;
    const r = await getJSON(url);
    return r.daily;
  });
}

// ECMWF 51-member ensemble at mid-mountain → probabilistic daily snowfall.
export function fetchEnsemble() {
  return cached('nk-ensemble-v1', 120, async () => {
    const url = `${API.ensemble}?${qs({
      latitude: SUMMIT.lat, longitude: SUMMIT.lon, elevation: 1100,
      hourly: 'snowfall', models: 'ecmwf_ifs025', forecast_days: 15, timezone: 'Asia/Tokyo',
    })}`;
    const r = await getJSON(url);
    const h = r.hourly;
    const members = Object.keys(h).filter(k => k.startsWith('snowfall'));
    const days = {};
    h.time.forEach((t, i) => {
      const d = t.slice(0, 10);
      days[d] ??= new Array(members.length).fill(0);
      members.forEach((m, j) => { days[d][j] += h[m][i] ?? 0; });
    });
    return days; // { 'YYYY-MM-DD': [member totals cm] }
  });
}

// Climatology: daily snowfall around today for the last 10 seasons (reanalysis).
export function fetchClimatology() {
  const today = new Date();
  return cached('nk-clim-v1-' + today.toISOString().slice(0, 10), 60 * 24 * 7, async () => {
    const jobs = [];
    for (let y = 1; y <= 10; y++) {
      const s = new Date(today); s.setFullYear(s.getFullYear() - y); s.setDate(s.getDate() - 7);
      const e = new Date(s); e.setDate(e.getDate() + 45);
      jobs.push(getJSON(`${API.archive}?${qs({
        latitude: SUMMIT.lat, longitude: SUMMIT.lon, elevation: 1100,
        start_date: s.toISOString().slice(0, 10), end_date: e.toISOString().slice(0, 10),
        daily: 'snowfall_sum', timezone: 'Asia/Tokyo',
      })}`).then(r => r.daily));
    }
    const res = await Promise.allSettled(jobs);
    // Average by month-day key.
    const acc = {};
    for (const r of res) {
      if (r.status !== 'fulfilled') continue;
      r.value.time.forEach((t, i) => {
        const md = t.slice(5);
        (acc[md] ??= []).push(r.value.snowfall_sum[i] ?? 0);
      });
    }
    const out = {};
    for (const [md, v] of Object.entries(acc)) out[md] = { mean: v.reduce((a, b) => a + b, 0) / v.length, n: v.length, max: Math.max(...v) };
    return out;
  });
}

// ---------- Sampling helpers ----------

// Index of the hourly slot at or before time t.
export function slotAt(series, t) {
  const T = series.time;
  if (t <= T[0]) return 0;
  if (t >= T[T.length - 1]) return T.length - 1;
  let lo = 0, hi = T.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  return lo;
}

// Weather state for one location at time t (with 24h snowfall sums).
export function stateAt(series, t) {
  const i = slotAt(series, t);
  const g = k => series[k]?.[i] ?? null;
  let snow24 = 0, snow72 = 0, snow7d = 0;
  for (let k = 0; k < 168 && i - k >= 0; k++) {
    const s = series.snowfall[i - k] ?? 0;
    if (k < 24) snow24 += s;
    if (k < 72) snow72 += s;
    snow7d += s;
  }
  return {
    time: series.time[i], temp: g('temperature_2m'), precip: g('precipitation'), rain: g('rain'), snowfall: g('snowfall'),
    snowDepth: g('snow_depth'), code: g('weather_code'), cloud: g('cloud_cover'), cloudLow: g('cloud_cover_low'),
    visibility: g('visibility'), wind: g('wind_speed_10m'), windDir: g('wind_direction_10m'), gust: g('wind_gusts_10m'),
    freezing: g('freezing_level_height'), isDay: g('is_day'), snow24, snow72, snow7d, elevation: series.elevation,
  };
}

// Aggregate state used to drive the 3D scene (bases averaged vs summit).
export function sceneState(data, t, focusId) {
  const top = stateAt(data.summit, t);
  const bases = RESORTS.map(r => stateAt(data[r.id], t));
  const focus = focusId && data[focusId] ? stateAt(data[focusId], t) : null;
  const avg = k => bases.reduce((a, b) => a + (b[k] ?? 0), 0) / bases.length;
  return {
    top, bases, focus,
    baseDepth: avg('snowDepth'), topDepth: top.snowDepth ?? 0,
    baseElev: avg('elevation'), topElev: top.elevation,
    // Drive particles from the focused resort, otherwise mid-mountain blend.
    snowfall: focus ? focus.snowfall : (top.snowfall + avg('snowfall')) / 2,
    rain: focus ? focus.rain : avg('rain'),
    temp: focus ? focus.temp : (top.temp + avg('temp')) / 2,
    wind: focus ? focus.wind : top.wind, windDir: top.windDir,
    cloud: Math.max(top.cloud ?? 0, avg('cloud')), cloudLow: top.cloudLow,
    visibility: Math.min(focus?.visibility ?? 1e9, avg('visibility') || 24000),
    snow24: focus ? focus.snow24 : top.snow24, freezing: top.freezing,
  };
}

export const WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'], 80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunder + hail', '⛈️'], 99: ['Thunder + hail', '⛈️'],
};
export const wmo = c => WMO[c] ?? ['—', '❔'];
