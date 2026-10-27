// Lift-queue ESTIMATOR. No free/public API publishes Niseko queue lengths,
// so this is a transparent heuristic model: season peaks × weekday × hour ×
// powder-day rush × wind holds × how much of a bottleneck each lift is.

// Peak periods (inclusive, JST). Update each season.
const PEAKS = [
  { from: '2026-12-24', to: '2027-01-05', f: 1.9, why: 'Christmas – New Year' },
  { from: '2027-01-06', to: '2027-01-31', f: 1.35, why: 'Australian school holidays' },
  { from: '2027-02-04', to: '2027-02-14', f: 1.8, why: 'Lunar New Year + Sapporo Snow Festival' },
  { from: '2027-02-20', to: '2027-02-23', f: 1.4, why: "Emperor's Birthday long weekend" },
  { from: '2027-03-19', to: '2027-03-22', f: 1.2, why: 'Vernal Equinox long weekend' },
  { from: '2026-12-01', to: '2026-12-12', f: 0.55, why: 'Early season' },
  { from: '2027-03-23', to: '2027-05-06', f: 0.5, why: 'Spring' },
];
const HOLIDAYS = ['2026-11-03', '2026-11-23', '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-22'];
// Typical Niseko United season window.
const SEASON = { open: '2026-11-28', close: '2027-05-06' };

const RESORT_BASE = { hirafu: 1.0, hanazono: 0.8, village: 0.7, annupuri: 0.55, other: 0.25 };
// Bottleneck factor per lift (base access lifts queue most).
function liftFactor(name) {
  const n = name.toLowerCase();
  if (/ace family|king gondola|niseko gondola|annupuri gondola|symphony|ace gondola/.test(n)) return { f: 1.0, gondola: /gondola/.test(n), access: true };
  if (/king #4|king lift #4|ace pair #4|jumbo pair #4|wonderland|hanazono quad #3/.test(n)) return { f: 0.75, top: true };
  if (/village express|hanazono hooded|king hooded|jumbo quad|dream|banzai|community/.test(n)) return { f: 0.6 };
  return { f: 0.4 };
}

const dateKey = d => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
const jstHour = d => Number(d.toLocaleString('en-GB', { timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23' })) + d.getUTCMinutes() / 60;

export function seasonInfo(date) {
  const k = dateKey(date);
  const p = PEAKS.find(p => k >= p.from && k <= p.to);
  const dow = new Date(k + 'T12:00:00+09:00').getUTCDay();
  const weekend = dow === 0 || dow === 6 || HOLIDAYS.includes(k);
  return { key: k, open: k >= SEASON.open && k <= SEASON.close, peak: p, weekend };
}

/**
 * @param {Date} date
 * @param {{snow24?:number, gust?:number, temp?:number}} wx  summit weather at that time
 */
export function estimateQueues(date, wx = {}) {
  const s = seasonInfo(date);
  const hour = jstHour(date);
  const reasons = [];
  if (!s.open) return { open: false, reasons: [`Outside the usual season (${SEASON.open} → ${SEASON.close})`], lift: () => null };
  const night = hour >= 16.5 && hour < 20.5;
  if (hour < 8.5 || hour >= 20.5) return { open: false, reasons: ['Lifts closed (operating ~8:30 – 20:30)'], lift: () => null };

  let demand = 1;
  if (s.peak) { demand *= s.peak.f; reasons.push(`${s.peak.why} ×${s.peak.f}`); }
  if (s.weekend) { demand *= 1.25; reasons.push('Weekend / public holiday ×1.25'); }
  // Morning rush 8:30-10:30, lunch dip, afternoon taper.
  const tod = night ? 0.25 : hour < 9 ? 1.5 : hour < 10.5 ? 1.35 : hour < 12 ? 0.9 : hour < 13 ? 0.6 : hour < 14.5 ? 0.75 : 0.45;
  demand *= tod;
  const powder = (wx.snow24 ?? 0) >= 20 ? 1.5 : (wx.snow24 ?? 0) >= 10 ? 1.25 : 1;
  if (powder > 1) reasons.push(`Powder day (${Math.round(wx.snow24)} cm/24h) ×${powder}`);
  const windHold = (wx.gust ?? 0) >= 60;
  if (windHold) reasons.push(`Wind gusts ${Math.round(wx.gust)} km/h → gondolas / top lifts likely on hold`);
  if ((wx.temp ?? -5) < -15) { demand *= 0.85; reasons.push('Very cold ×0.85'); }

  return {
    open: true, reasons, night,
    lift(l) {
      const lf = liftFactor(l.name);
      if (l.type === 'magic_carpet') return null;
      if (windHold && (lf.gondola || lf.top)) return { min: null, text: 'wind hold?', color: '#64748b', level: 'hold' };
      if (night && l.resort === 'hanazono') return { min: null, text: 'closed (night)', color: '#64748b', level: 'closed' };
      const powderBoost = lf.top && hour < 11.5 ? powder * 1.2 : powder;
      const raw = 10 * demand * powderBoost * (RESORT_BASE[l.resort] ?? 0.4) * lf.f;
      const min = Math.round(40 * (1 - Math.exp(-raw / 40))); // soft cap: queues rarely exceed ~35 min
      const level = min < 5 ? 'low' : min < 12 ? 'med' : min < 20 ? 'high' : 'vhigh';
      const color = { low: '#22c55e', med: '#eab308', high: '#f97316', vhigh: '#ef4444' }[level];
      return { min, text: min < 3 ? '<3 min' : `~${min} min`, color, level };
    },
  };
}
