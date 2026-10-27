// Central configuration: geography, data sources and resort metadata.

// Area modelled in 3D (covers all four Niseko United resorts + Mt. Moiwa).
export const BBOX = { south: 42.832, north: 42.902, west: 140.615, east: 140.722 };

export const SUMMIT = { lat: 42.8750, lon: 140.6588, ele: 1308, name: 'Mt. Niseko Annupuri' };

// Quality presets — chosen in the Layers panel, stored in localStorage.
// demZoom 15 = GSI 5 m elevation; hdZoom = extra-sharp photo patch around the view.
export const QUALITY = {
  ultra:    { label: 'Ultra (4K / retina)', demZoom: 15, imgZoom: 16, segments: 1800, pixelRatio: 2,   shadows: true,  shadowMap: 8192, maxFlakes: 140000, nearFlakes: 9000, hdZoom: 18, hdTiles: 10 },
  high:     { label: 'High',                demZoom: 15, imgZoom: 16, segments: 1100, pixelRatio: 2,   shadows: true,  shadowMap: 4096, maxFlakes: 80000,  nearFlakes: 6000, hdZoom: 18, hdTiles: 8 },
  balanced: { label: 'Balanced (phones)',   demZoom: 14, imgZoom: 15, segments: 640,  pixelRatio: 1.5, shadows: false, shadowMap: 2048, maxFlakes: 25000,  nearFlakes: 2500, hdZoom: 17, hdTiles: 6 },
};

// Free, key-less tile sources (CORS enabled).
export const TILES = {
  // GSI (Geospatial Information Authority of Japan) elevation: 5 m (z15) and 10 m (z14).
  demGSI5: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5c_png/${z}/${x}/${y}.png`,
  demGSI10: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`,
  // AWS Open Data "Terrarium" elevation (SRTM-based) — fallback.
  demAWS: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  // GSI seamless aerial photos (sharpest for Japan), Esri World Imagery as fallback.
  imgGSI: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`,
  imgEsri: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};

// Open-Meteo (free, no API key, non-commercial use).
export const API = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  ensemble: 'https://ensemble-api.open-meteo.com/v1/ensemble',
  archive:  'https://archive-api.open-meteo.com/v1/archive',
};

export const RESORTS = [
  {
    id: 'annupuri', name: 'Niseko Annupuri', short: 'Annupuri', color: '#38bdf8',
    base: { lat: 42.8478, lon: 140.6478, ele: 320 }, top: { lat: 42.8688, lon: 140.6616 },
    blurb: 'Wide cruisy groomers, quieter base, great sunset views over Mt. Yotei & the Sea of Japan.',
  },
  {
    id: 'village', name: 'Niseko Village', short: 'Village', color: '#a78bfa',
    base: { lat: 42.8452, lon: 140.6835, ele: 300 }, top: { lat: 42.8693, lon: 140.6622 },
    blurb: 'Tree runs and the Hilton / Park Hyatt base. Wonderland chairs reach the summit gates.',
  },
  {
    id: 'hirafu', name: 'Grand Hirafu', short: 'Hirafu', color: '#f97316',
    base: { lat: 42.8590, lon: 140.7018, ele: 290 }, top: { lat: 42.8716, lon: 140.6625 },
    blurb: 'The biggest and busiest area — village nightlife, night skiing and the King / Ace gondolas.',
  },
  {
    id: 'hanazono', name: 'Hanazono', short: 'Hanazono', color: '#f43f5e',
    base: { lat: 42.8916, lon: 140.6992, ele: 310 }, top: { lat: 42.8731, lon: 140.6677 },
    blurb: 'Famous Strawberry Fields tree zone, family friendly base and Symphony gondola.',
  },
];

// Points we request weather for (one call, five locations).
export const WEATHER_POINTS = [
  { id: 'summit', name: 'Summit (1308 m)', lat: SUMMIT.lat, lon: SUMMIT.lon, elevation: 1250 },
  ...RESORTS.map(r => ({ id: r.id, name: `${r.short} base`, lat: r.base.lat, lon: r.base.lon, elevation: r.base.ele })),
];

export const PISTE_COLORS = { easy: '#22c55e', novice: '#22c55e', intermediate: '#ef4444', advanced: '#111827', expert: '#111827', freeride: '#f59e0b', unknown: '#9ca3af' };

// On-mountain checkpoints (coordinates from OpenStreetMap; ✳ = approximate).
// type: base | food | lift | summit | terrain
export const CHECKPOINTS = [
  { id: 'hana308', name: 'Hanazono 308 (base lodge & canteen)', resort: 'hanazono', type: 'food', lat: 42.89325, lon: 140.69989, blurb: 'Main Hanazono base building — Café HANAZONO 308, rentals, ski school and lockers.' },
  { id: 'hana1', name: 'HANA1 Café', resort: 'hanazono', type: 'food', lat: 42.89150, lon: 140.69969, blurb: 'Café next to the Hanazono Hooded Lift #1 base.' },
  { id: 'hanaSymTop', name: 'Symphony Gondola top', resort: 'hanazono', type: 'lift', lat: 42.88942, lon: 140.68350, blurb: 'Top of the Hanazono Symphony Gondola.' },
  { id: 'strawberry', name: 'Strawberry Fields ✳', resort: 'hanazono', type: 'terrain', lat: 42.8800, lon: 140.6800, blurb: 'Hanazono\'s famous gladed tree zone (approximate location). Check gate status before entering.' },
  { id: 'hanaQ3Top', name: 'Hanazono Quad #3 top', resort: 'hanazono', type: 'lift', lat: 42.87309, lon: 140.66767, blurb: 'Highest Hanazono lift — links across to Hirafu\'s upper mountain.' },
  { id: 'hirafuBase', name: 'Hirafu Welcome Center', resort: 'hirafu', type: 'base', lat: 42.85835, lon: 140.70201, blurb: 'Grand Hirafu main base: Ace Family Quad, tickets and the bus terminal.' },
  { id: 'kumo', name: 'Kumo Restaurant', resort: 'hirafu', type: 'food', lat: 42.86290, lon: 140.69821, blurb: 'On-mountain restaurant near the King gondola base area.' },
  { id: 'kiosk', name: 'Mountain Kiosk Coffee', resort: 'hirafu', type: 'food', lat: 42.86248, lon: 140.69863, blurb: 'Coffee stop on the lower Hirafu slopes.' },
  { id: 'boyoso', name: 'Boyoso', resort: 'hirafu', type: 'food', lat: 42.86804, lon: 140.69339, blurb: 'Classic mid-mountain lodge — curry and ramen with Mt. Yotei views.' },
  { id: 'nest813', name: 'NEST813 / Ace Gondola top', resort: 'hirafu', type: 'food', lat: 42.86776, lon: 140.68015, blurb: 'Restaurant at about 813 m beside the Ace Gondola top station.' },
  { id: 'hut1000', name: '1000m Hut', resort: 'hirafu', type: 'food', lat: 42.86809, lon: 140.66920, blurb: 'Small hut around 1,000 m — warm up before the summit lifts.' },
  { id: 'king4Top', name: 'King #4 top / summit gate', resort: 'hirafu', type: 'lift', lat: 42.87167, lon: 140.66246, blurb: 'Highest lift at Hirafu. Hike to the summit only through an open gate.' },
  { id: 'villageBase', name: 'Niseko Village base', resort: 'village', type: 'base', lat: 42.84696, lon: 140.68420, blurb: 'Niseko Gondola base by the Hilton.' },
  { id: 'villageGondTop', name: 'Niseko Gondola top', resort: 'village', type: 'lift', lat: 42.86567, lon: 140.66726, blurb: 'Top of the Niseko Village gondola.' },
  { id: 'lookout', name: 'The Lookout Café', resort: 'village', type: 'food', lat: 42.86188, lon: 140.66632, blurb: 'Café at the top of the Niseko Gondola with Yotei views.' },
  { id: 'annupuriBase', name: 'Annupuri base & food court', resort: 'annupuri', type: 'base', lat: 42.84846, lon: 140.64619, blurb: 'Annupuri base centre with food court and gondola.' },
  { id: 'nook', name: 'Nook Annupuri', resort: 'annupuri', type: 'food', lat: 42.84918, lon: 140.64543, blurb: 'Restaurant at the Annupuri base.' },
  { id: 'paradise', name: 'Paradise Hut', resort: 'annupuri', type: 'food', lat: 42.85626, lon: 140.65240, blurb: 'Mid-mountain hut on the Annupuri side.' },
  { id: 'annupuriGondTop', name: 'Annupuri Gondola top', resort: 'annupuri', type: 'lift', lat: 42.86447, lon: 140.66113, blurb: 'Top of the Annupuri Gondola.' },
  { id: 'summit', name: 'Niseko Annupuri summit', resort: 'summit', type: 'summit', lat: 42.8750, lon: 140.6588, blurb: '1,308 m peak. Reached by a short hike from the summit gates when they are open.' },
];
export const CHECKPOINT_ICONS = { base: '🏠', food: '🍜', lift: '🚡', summit: '⛰️', terrain: '🌲', custom: '📌' };
