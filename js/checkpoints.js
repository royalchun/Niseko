// Checkpoints: pins on the mountain with a detail card — live weather at that
// exact spot & elevation, sun/shade from the real terrain horizon, slope and
// aspect, nearby lifts (with queue estimate) and runs, plus an eye-level view.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { API, CHECKPOINTS, CHECKPOINT_ICONS, RESORTS } from './config.js';
import { cached, getJSON, qs, jst, stateAt, slotAt, wmo } from './weather.js';
import { sunPosition } from './effects.js';

const HOURLY = ['temperature_2m', 'apparent_temperature', 'precipitation', 'rain', 'snowfall', 'snow_depth', 'weather_code', 'cloud_cover',
  'visibility', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'freezing_level_height'];
const CUSTOM_KEY = 'nk-custom-checkpoints-v1';
const resortOf = id => RESORTS.find(r => r.id === id);
const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg ?? 0) % 360) + 360) % 360 / 45) % 8];
const fmt = (v, d = 0, u = '') => (v == null || Number.isNaN(v) ? '—' : `${Number(v).toFixed(d).replace(/^-(0\.?0*)$/, '$1')}${u}`);
const hhmm = t => new Date(t).toLocaleTimeString(undefined, { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loadCustom() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch { return []; }
}
function saveCustom(list) {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

function fetchPoint(cp, elevation) {
  const key = `nk-cp-${cp.lat.toFixed(4)}-${cp.lon.toFixed(4)}-v1`;
  return cached(key, 30, async () => {
    const r = await getJSON(`${API.forecast}?${qs({
      latitude: cp.lat, longitude: cp.lon, elevation: Math.round(elevation),
      hourly: HOURLY.join(','), past_days: 2, forecast_days: 4, timezone: 'Asia/Tokyo',
    })}`);
    const h = r.hourly;
    return { elevation: r.elevation, time: h.time.map(jst), ...Object.fromEntries(HOURLY.map(k => [k, h[k]])) };
  });
}

export function initCheckpoints(ctx) {
  const { terrain, overlays, osm, camera, controls, $, flyTo, getTime, getExag, queueFor, toast, onStand } = ctx;
  const { frame, elevationAt } = terrain;
  const group = new THREE.Group();
  overlays.group.add(group);
  let all = [], active = null, chart = null, placing = false;

  // ---------- Terrain analysis ----------
  function localOf(cp) { return frame.toLocal(cp.lat, cp.lon); }
  function slopeAspect(p) {
    const e = 10;
    const dzx = (elevationAt(p.x + e, p.z) - elevationAt(p.x - e, p.z)) / (2 * e);
    const dzz = (elevationAt(p.x, p.z + e) - elevationAt(p.x, p.z - e)) / (2 * e);
    const slope = (Math.atan(Math.hypot(dzx, dzz)) * 180) / Math.PI;
    // Aspect = direction the slope faces (downhill). x = east, z = south.
    const aspect = ((Math.atan2(-dzx, dzz) * 180) / Math.PI + 180 + 360) % 360;
    return { slope, aspect };
  }
  // Is the sun above the real terrain horizon at this point?
  function inSun(p, h0, date) {
    const { elevation, azimuth } = sunPosition(date, frame.toLatLon(p.x, p.z).lat, frame.toLatLon(p.x, p.z).lon);
    if (elevation <= 0) return false;
    const dx = Math.sin(azimuth), dz = -Math.cos(azimuth), tanEl = Math.tan(elevation);
    for (let d = 25; d < 9000; d += d < 500 ? 25 : 80) {
      const x = p.x + dx * d, z = p.z + dz * d;
      if (Math.abs(x) > frame.width / 2 || Math.abs(z) > frame.depth / 2) break;
      if (elevationAt(x, z) > h0 + 2 + d * tanEl) return false;
    }
    return true;
  }
  function sunWindow(p, h0, t) {
    const day0 = Date.parse(new Date(t + 9 * 36e5).toISOString().slice(0, 10) + 'T00:00:00+09:00');
    let first = null, last = null, minutes = 0;
    for (let m = 4 * 60; m <= 20 * 60; m += 10) {
      const d = new Date(day0 + m * 6e4);
      if (inSun(p, h0, d)) { first ??= d.getTime(); last = d.getTime(); minutes += 10; }
    }
    return { first, last, minutes };
  }

  // ---------- Markers ----------
  function makeMarker(cp) {
    const p = localOf(cp);
    const el = document.createElement('button');
    el.className = `label cp-marker ${cp.custom ? 'custom' : ''}`;
    el.style.setProperty('--c', resortOf(cp.resort)?.color ?? '#e2e8f0');
    el.innerHTML = `<span class="cp-ico">${CHECKPOINT_ICONS[cp.type] ?? '📍'}</span><span class="cp-name">${esc(cp.name)}</span>`;
    el.title = cp.name;
    el.addEventListener('click', e => { e.stopPropagation(); open(cp.id, true); });
    const obj = new CSS2DObject(el);
    obj.position.set(p.x, elevationAt(p.x, p.z) + 22, p.z);
    obj.userData.cp = cp;
    group.add(obj);
    return obj;
  }
  function rebuild() {
    for (const o of [...group.children]) { o.element.remove(); group.remove(o); }
    all = [...CHECKPOINTS, ...loadCustom().map(c => ({ ...c, custom: true, type: 'custom' }))];
    all.forEach(makeMarker);
    renderList();
  }

  // ---------- List panel ----------
  function renderList() {
    const q = ($('#cp-search')?.value ?? '').toLowerCase();
    const groups = [...RESORTS.map(r => ({ id: r.id, name: r.name, color: r.color })), { id: 'summit', name: 'Summit', color: '#e2e8f0' }, { id: 'custom', name: 'My checkpoints', color: '#fbbf24' }];
    $('#cp-list').innerHTML = groups.map(g => {
      const items = all.filter(c => (g.id === 'custom' ? c.custom : !c.custom && c.resort === g.id) && c.name.toLowerCase().includes(q));
      if (!items.length) return '';
      return `<div class="cp-group" style="--c:${g.color}"><h4>${g.name}</h4>${items.map(c => {
        const p = localOf(c);
        return `<button class="cp-item" data-cp="${c.id}"><span>${CHECKPOINT_ICONS[c.type] ?? '📍'}</span><span>${esc(c.name)}</span><small>${Math.round(elevationAt(p.x, p.z))} m</small></button>`;
      }).join('')}</div>`;
    }).join('') || '<p class="muted">No matches.</p>';
    $('#cp-list').querySelectorAll('[data-cp]').forEach(b => b.addEventListener('click', () => open(b.dataset.cp, true)));
  }

  // ---------- Detail card ----------
  async function open(id, fly) {
    const cp = all.find(c => c.id === id);
    if (!cp) return;
    active = cp;
    ctx.showPanel('panel-cp');
    group.children.forEach(o => o.element.classList.toggle('active', o.userData.cp.id === id));
    const p = localOf(cp);
    const h0 = elevationAt(p.x, p.z);
    if (fly) {
      const t = new THREE.Vector3(p.x, h0 * getExag(), p.z);
      const off = camera.position.clone().sub(controls.target).setY(0);
      if (off.lengthSq() < 1) off.set(0, 0, 1);
      off.setLength(700).setY(420);
      flyTo(t, t.clone().add(off), 1400);
    }
    render(cp, p, h0, null);
    try {
      const wx = await fetchPoint(cp, h0);
      if (active === cp) render(cp, p, h0, wx);
    } catch (e) {
      if (active === cp) render(cp, p, h0, { error: e.message });
    }
  }

  function render(cp, p, h0, wx) {
    const t = getTime();
    const r = resortOf(cp.resort);
    const { slope, aspect } = slopeAspect(p);
    const sunNow = inSun(p, h0, new Date(t));
    const win = sunWindow(p, h0, t);
    const st = wx && !wx.error ? stateAt(wx, t) : null;
    const i = st ? slotAt(wx, t) : -1;
    const feels = st ? wx.apparent_temperature[i] : null;
    const precipType = st ? ((st.freezing ?? 9999) < h0 + 150 || (st.temp ?? 5) < 0.5 ? 'snow' : 'rain') : null;
    const [desc, icon] = st ? wmo(st.code) : ['Loading live weather…', '⏳'];

    // Nearest lifts (by closest station) and nearby runs.
    const lifts = overlays.lifts.map(L => {
      const d = Math.min(...[L.data.pts[0], L.data.pts[L.data.pts.length - 1]].map(([la, lo]) => { const q = frame.toLocal(la, lo); return Math.hypot(q.x - p.x, q.z - p.z); }));
      return { L, d };
    }).sort((a, b) => a.d - b.d).slice(0, 4);
    const runs = {};
    for (const run of osm.pistes) {
      const near = run.pts.some(([la, lo]) => { const q = frame.toLocal(la, lo); return Math.hypot(q.x - p.x, q.z - p.z) < 250; });
      if (near) (runs[run.diff] ??= new Set()).add(run.name ?? 'Unnamed');
    }
    const runColors = { easy: '#22c55e', novice: '#22c55e', intermediate: '#ef4444', advanced: '#e2e8f0', expert: '#e2e8f0' };

    const aspectNote = slope < 4 ? 'Almost flat' : aspect >= 292.5 || aspect < 67.5 ? 'North-facing — keeps powder longest' : aspect >= 112.5 && aspect < 247.5 ? 'South-facing — softens in sun, crusts later' : aspect < 180 ? 'East-facing — morning sun' : 'West-facing — afternoon sun';
    $('#cp-body').innerHTML = `
      <div class="cp-head" style="--c:${r?.color ?? '#e2e8f0'}">
        <div class="cp-big">${CHECKPOINT_ICONS[cp.type] ?? '📍'}</div>
        <div><h2>${esc(cp.name)}</h2><div class="muted">${r?.name ?? (cp.resort === 'summit' ? 'Summit' : 'My checkpoint')} · ${cp.lat.toFixed(5)}, ${cp.lon.toFixed(5)}</div></div>
      </div>
      ${cp.blurb ? `<p class="cp-blurb">${esc(cp.blurb)}</p>` : ''}
      <div class="cp-now"><span class="cp-wx">${icon}</span><div><b>${desc}</b><div class="muted">${new Date(t).toLocaleString(undefined, { timeZone: 'Asia/Tokyo', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} JST · follows the timeline</div></div></div>
      ${wx?.error ? `<div class="warn">⚠️ Live weather unavailable (${esc(wx.error)}). Try again in a minute.</div>` : ''}
      <div class="cond-grid cp-grid">
        <div><span>Temperature</span><b>${fmt(st?.temp, 1, '°C')}</b></div>
        <div><span>Feels like</span><b>${fmt(feels, 0, '°C')}</b></div>
        <div><span>Falling now</span><b>${st ? (st.precip > 0.05 ? `${precipType === 'snow' ? '❄️' : '💧'} ${fmt(precipType === 'snow' ? st.snowfall : st.rain, 1, precipType === 'snow' ? ' cm/h' : ' mm/h')}` : 'Nothing') : '—'}</b></div>
        <div><span>Snow last 24 h</span><b>${fmt(st?.snow24, 0, ' cm')}</b></div>
        <div><span>Wind</span><b>${st ? `${fmt(st.wind, 0)} km/h ${compass(st.windDir)}` : '—'}</b></div>
        <div><span>Gusts</span><b>${fmt(st?.gust, 0, ' km/h')}</b></div>
        <div><span>Visibility</span><b>${st?.visibility == null ? '—' : st.visibility >= 10000 ? `${Math.round(st.visibility / 1000)} km` : `${(st.visibility / 1000).toFixed(1)} km`}</b></div>
        <div><span>Snow depth (model)</span><b>${fmt((st?.snowDepth ?? NaN) * 100, 0, ' cm')}</b></div>
        <div><span>Elevation (5 m DEM)</span><b>${Math.round(h0)} m</b></div>
        <div><span>Freezing level</span><b>${fmt(st?.freezing, 0, ' m')}</b></div>
        <div><span>Slope</span><b>${slope.toFixed(0)}°</b></div>
        <div><span>Faces</span><b>${compass(aspect)} (${Math.round(aspect)}°)</b></div>
      </div>
      <p class="cp-note">🧭 ${aspectNote}.</p>
      <p class="cp-note">${sunNow ? ((st?.cloud ?? 0) >= 70 ? `🌥️ Sun is above the terrain here, but hidden by cloud (${Math.round(st.cloud)}%)` : '☀️ <b>In the sun</b> right now') : '⛰️ <b>In shade</b> (or the sun is down) right now'}${win.first ? ` · direct sun here today ${hhmm(win.first)}–${hhmm(win.last)} (${Math.round(win.minutes / 60 * 10) / 10} h, terrain shadows included)` : ' · no direct sun here on this day'}.</p>
      <h3>Next 48 hours here</h3>
      <div class="cp-chart"><canvas id="cp-chart"></canvas></div>
      <h3>Nearest lifts</h3>
      <div class="cp-lifts">${lifts.map(({ L, d }) => {
        const q = queueFor(L.data);
        return `<div class="q-item"><span>${esc(L.data.name)} <small>${d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`}</small></span><b style="color:${q?.color ?? 'inherit'}">${q ? q.text : '<small>—</small>'}</b></div>`;
      }).join('')}</div>
      <h3>Runs within 250 m</h3>
      <div class="cp-runs">${Object.keys(runs).length ? Object.entries(runs).map(([diff, names]) => `<div><span class="run-dot" style="background:${runColors[diff] ?? '#9ca3af'}"></span><b>${diff}</b>: ${[...names].slice(0, 6).map(esc).join(', ')}</div>`).join('') : '<span class="muted">None mapped nearby.</span>'}</div>
      <div class="cp-actions">
        <button class="pill" data-a="fly">🎯 Fly here</button>
        <button class="pill" data-a="stand">👁️ Stand here</button>
        <button class="pill" data-a="share">🔗 Share</button>
        <a class="pill" href="https://www.google.com/maps/search/?api=1&query=${cp.lat},${cp.lon}" target="_blank" rel="noopener">🗺️ Google Maps</a>
        ${cp.custom ? '<button class="pill danger" data-a="remove">🗑️ Remove</button>' : ''}
      </div>
      <p class="muted small">Weather: Open-Meteo, downscaled to this exact elevation. Sun/shade computed from the 3D terrain.</p>`;

    const act = {
      fly: () => open(cp.id, true),
      stand: () => onStand(p, h0, aspect),
      share: () => ctx.share({ cp: cp.custom ? `${cp.lat.toFixed(5)},${cp.lon.toFixed(5)},${cp.name}` : cp.id }),
      remove: () => { saveCustom(loadCustom().filter(c => c.id !== cp.id)); ctx.showPanel(null); rebuild(); toast('Checkpoint removed'); },
    };
    $('#cp-body').querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => act[b.dataset.a]()));
    if (st) drawChart(wx, t);
  }

  function drawChart(wx, t) {
    const Chart = window.Chart;
    if (!Chart) return;
    const i0 = slotAt(wx, t), idx = [];
    for (let i = i0; i < Math.min(wx.time.length, i0 + 48); i++) idx.push(i);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--fg-muted').trim(), grid = css.getPropertyValue('--grid').trim();
    const data = {
      labels: idx.map(i => new Date(wx.time[i]).toLocaleString(undefined, { timeZone: 'Asia/Tokyo', weekday: 'short', hour: '2-digit' })),
      datasets: [
        { type: 'bar', label: 'Snow (cm/h)', data: idx.map(i => wx.snowfall[i]), backgroundColor: '#38bdf8', yAxisID: 'y', borderRadius: 2 },
        { type: 'bar', label: 'Rain (mm/h)', data: idx.map(i => wx.rain[i]), backgroundColor: 'rgba(96,165,250,.45)', yAxisID: 'y', borderRadius: 2 },
        { type: 'line', label: 'Temp (°C)', data: idx.map(i => wx.temperature_2m[i]), borderColor: '#f59e0b', pointRadius: 0, borderWidth: 2, yAxisID: 'y2', tension: 0.3 },
      ],
    };
    const options = {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: fg, boxWidth: 10, font: { size: 10 } } } },
      scales: {
        x: { ticks: { color: fg, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: grid } },
        y: { beginAtZero: true, ticks: { color: fg }, grid: { color: grid } },
        y2: { position: 'right', ticks: { color: fg }, grid: { display: false } },
      },
    };
    chart?.destroy();
    chart = new Chart($('#cp-chart'), { data, options });
  }

  // ---------- Custom checkpoints ----------
  function startPlacing() {
    placing = true;
    ctx.showPanel(null);
    document.body.classList.add('placing');
    toast('📌 Tap / click the spot on the mountain for your checkpoint (Esc to cancel)', 4000);
  }
  function place(point) {
    if (!placing) return false;
    placing = false;
    document.body.classList.remove('placing');
    const ll = frame.toLatLon(point.x, point.z);
    const name = prompt('Name this checkpoint (e.g. "Meet here after lunch")', 'My spot');
    if (!name) return true;
    const cp = { id: `c${Date.now().toString(36)}`, name: name.slice(0, 60), lat: ll.lat, lon: ll.lon, resort: 'custom' };
    saveCustom([...loadCustom(), cp]);
    rebuild();
    open(cp.id, false);
    return true;
  }
  // Shared links can carry a custom checkpoint as "lat,lon,name".
  function addShared(spec) {
    const [lat, lon, ...rest] = spec.split(',');
    if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) return null;
    const name = rest.join(',') || 'Shared spot';
    const existing = loadCustom().find(c => Math.abs(c.lat - lat) < 1e-5 && Math.abs(c.lon - lon) < 1e-5);
    if (existing) return existing.id;
    const cp = { id: `c${Date.now().toString(36)}`, name: name.slice(0, 60), lat: +lat, lon: +lon, resort: 'custom' };
    saveCustom([...loadCustom(), cp]);
    rebuild();
    return cp.id;
  }

  // Labels: names only when close; icons always.
  function update() {
    for (const o of group.children) {
      const d = camera.position.distanceTo(o.position);
      o.element.classList.toggle('far', d > 3000);
    }
  }

  $('#cp-search').addEventListener('input', renderList);
  $('#cp-add').addEventListener('click', startPlacing);
  addEventListener('keydown', e => { if (e.key === 'Escape' && placing) { placing = false; document.body.classList.remove('placing'); } });
  rebuild();

  return {
    group, open, update, place, addShared, startPlacing,
    get placing() { return placing; },
    refresh() { if (active && !$('#panel-cp').hidden) open(active.id, false); },
    setVisible(on) { group.children.forEach(o => (o.visible = on)); },
  };
}
