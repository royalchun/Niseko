// Snow prediction: blends multi-model forecasts, the ECMWF ensemble and
// 10-season climatology, weighting each by how skilful it is at that lead time.
import { MODELS } from './weather.js';

const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
};
const fmtDay = d => new Date(d + 'T12:00:00+09:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00+09:00'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// Snow quality from temperature (snow-to-liquid ratio rises as it gets colder).
export function snowQuality(tmax, tmin) {
  if (tmax == null) return { label: '—', stars: 0 };
  const t = (tmax + tmin) / 2;
  if (t <= -8) return { label: 'Dry "Japow"', stars: 5 };
  if (t <= -4) return { label: 'Powder', stars: 4 };
  if (t <= -1) return { label: 'Soft', stars: 3 };
  if (t <= 1.5) return { label: 'Heavy / wet', stars: 2 };
  return { label: 'Rain risk', stars: 1 };
}

/**
 * @returns {{days: Array, summary: object}}
 * Each day: { date, label, past, models:{}, blend, min, max, p10, p50, p90, prob10, prob25, clim, final, low, high, source, tmax, tmin, gust, quality }
 */
export function analyse({ multi, ens, clim }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const days = [];
  const dates = multi?.time ?? [];
  dates.forEach((date, i) => {
    const vals = {}, temps = [];
    let wsum = 0, bsum = 0;
    for (const m of MODELS) {
      const v = multi[`snowfall_sum_${m.id}`]?.[i];
      if (v != null) { vals[m.id] = v; wsum += m.weight; bsum += v * m.weight; }
      const tx = multi[`temperature_2m_max_${m.id}`]?.[i], tn = multi[`temperature_2m_min_${m.id}`]?.[i];
      if (tx != null) temps.push([tx, tn]);
    }
    const mv = Object.values(vals);
    const gusts = MODELS.map(m => multi[`wind_gusts_10m_max_${m.id}`]?.[i]).filter(v => v != null);
    const tmax = temps.length ? temps.reduce((a, b) => a + b[0], 0) / temps.length : null;
    const tmin = temps.length ? temps.reduce((a, b) => a + b[1], 0) / temps.length : null;
    days.push({
      date, label: fmtDay(date), past: date < today, lead: Math.round((Date.parse(date) - Date.parse(today)) / 864e5),
      models: vals, blend: wsum ? bsum / wsum : null, min: mv.length ? Math.min(...mv) : null, max: mv.length ? Math.max(...mv) : null,
      tmax, tmin, gust: gusts.length ? Math.max(...gusts) : null,
    });
  });

  // Extend with climatology-only outlook to 30 days.
  const last = dates[dates.length - 1] ?? today;
  for (let k = 1; days.filter(d => !d.past).length < 30; k++) {
    const date = addDays(last, k);
    days.push({ date, label: fmtDay(date), past: false, lead: Math.round((Date.parse(date) - Date.parse(today)) / 864e5), models: {}, blend: null });
  }

  for (const d of days) {
    const members = ens?.[d.date];
    if (members?.length) {
      d.p10 = pct(members, 0.1); d.p50 = pct(members, 0.5); d.p90 = pct(members, 0.9);
      d.prob10 = members.filter(v => v >= 10).length / members.length;
      d.prob25 = members.filter(v => v >= 25).length / members.length;
    }
    const c = clim?.[d.date.slice(5)];
    d.clim = c ? c.mean : null;

    // Lead-time weighting: deterministic blend early, ensemble mid, climatology late.
    if (d.past) { d.final = d.blend; d.source = 'Model analysis'; }
    else {
      const parts = [];
      const L = d.lead;
      const wBlend = d.blend != null ? (L <= 5 ? 1 : L <= 10 ? 0.5 : 0.25) : 0;
      const wEns = d.p50 != null ? (L <= 5 ? 0.4 : L <= 10 ? 0.5 : 0.45) : 0;
      const wClim = d.clim != null ? (L <= 5 ? 0 : L <= 10 ? 0.15 : L <= 15 ? 0.3 : 1) : 0;
      if (wBlend) parts.push([d.blend, wBlend]);
      if (wEns) parts.push([(d.p50 + (d.p10 + d.p90) / 2) / 2, wEns]); // median nudged to mean
      if (wClim) parts.push([d.clim, wClim]);
      const W = parts.reduce((a, b) => a + b[1], 0);
      d.final = W ? parts.reduce((a, b) => a + b[0] * b[1], 0) / W : null;
      d.source = L > 15 ? 'Climatology' : L > 5 ? 'Ensemble + models' : 'Multi-model blend';
      d.low = d.p10 != null ? Math.min(d.p10, d.min ?? d.p10) : d.min ?? (d.clim != null ? 0 : null);
      d.high = d.p90 != null ? Math.max(d.p90, d.max ?? d.p90) : d.max ?? (d.clim != null ? (clim[d.date.slice(5)]?.max ?? d.clim * 2) : null);
    }
    d.quality = snowQuality(d.tmax, d.tmin);
  }

  const fut = days.filter(d => !d.past);
  const sum = (arr, n) => arr.slice(0, n).reduce((a, d) => a + (d.final ?? 0), 0);
  const climSum = n => fut.slice(0, n).reduce((a, d) => a + (d.clim ?? 0), 0);
  const best = fut.slice(0, 10).reduce((a, d) => (d.final ?? 0) > (a?.final ?? -1) ? d : a, null);
  const past = days.filter(d => d.past);
  return {
    days,
    summary: {
      next3: sum(fut, 3), next7: sum(fut, 7), next16: sum(fut, 16), next30: sum(fut, 30),
      clim7: climSum(7), clim30: climSum(30), past7: past.slice(-7).reduce((a, d) => a + (d.final ?? 0), 0),
      bestDay: best, powderDays: fut.slice(0, 16).filter(d => (d.final ?? 0) >= 15),
    },
  };
}

// Chart.js rendering of the analysis.
let chart;
export function renderChart(canvas, { days }) {
  const Chart = window.Chart;
  if (!Chart) return;
  const shown = days.filter(d => d.lead >= -14 && d.lead < 30);
  let cum = 0;
  const cumulative = shown.map(d => (d.past ? null : (cum += d.final ?? 0)));
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--fg-muted').trim() || '#94a3b8';
  const grid = css.getPropertyValue('--grid').trim() || 'rgba(148,163,184,.15)';
  const data = {
    labels: shown.map(d => d.label),
    datasets: [
      { type: 'bar', label: 'Uncertainty (10–90%)', data: shown.map(d => (d.past || d.low == null ? null : [d.low, d.high])), backgroundColor: 'rgba(56,189,248,.18)', borderWidth: 0, grouped: false, order: 3, barPercentage: 0.9 },
      { type: 'bar', label: 'Snowfall forecast (cm)', data: shown.map(d => (d.past ? null : d.final)), backgroundColor: shown.map(d => d.lead > 15 ? 'rgba(148,163,184,.55)' : d.lead > 5 ? 'rgba(56,189,248,.7)' : '#38bdf8'), grouped: false, order: 2, barPercentage: 0.55, borderRadius: 3 },
      { type: 'bar', label: 'Past 14 days (model analysis)', data: shown.map(d => (d.past ? d.final : null)), backgroundColor: 'rgba(167,139,250,.75)', grouped: false, order: 2, barPercentage: 0.55, borderRadius: 3 },
      { type: 'line', label: '10-season average', data: shown.map(d => d.clim), borderColor: '#f59e0b', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, tension: 0.3, order: 1 },
      { type: 'line', label: 'Cumulative (cm)', data: cumulative, borderColor: '#e2e8f0', pointRadius: 0, borderWidth: 2, yAxisID: 'y2', tension: 0.2, order: 0 },
    ],
  };
  const options = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: fg, boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          afterBody: items => {
            const d = shown[items[0].dataIndex];
            const lines = [`Source: ${d.source ?? ''}`, `Quality: ${d.quality.label}`];
            if (d.prob10 != null) lines.push(`Chance ≥10 cm: ${Math.round(d.prob10 * 100)}%  ≥25 cm: ${Math.round(d.prob25 * 100)}%`);
            for (const m of MODELS) if (d.models[m.id] != null) lines.push(`${m.name}: ${d.models[m.id].toFixed(1)} cm`);
            return lines;
          },
        },
      },
    },
    scales: {
      x: { stacked: false, ticks: { color: fg, maxRotation: 60, autoSkip: true, font: { size: 10 } }, grid: { color: grid } },
      y: { beginAtZero: true, title: { display: true, text: 'cm / day', color: fg }, ticks: { color: fg }, grid: { color: grid } },
      y2: { position: 'right', beginAtZero: true, title: { display: true, text: 'cumulative cm', color: fg }, ticks: { color: fg }, grid: { display: false } },
    },
  };
  if (chart) { chart.data = data; chart.options = options; chart.update(); }
  else chart = new Chart(canvas, { data, options });
}
