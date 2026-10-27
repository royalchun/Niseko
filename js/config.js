// Central configuration: geography, data sources and resort metadata.

// Area modelled in 3D (covers all four Niseko United resorts + Mt. Moiwa).
export const BBOX = { south: 42.832, north: 42.902, west: 140.615, east: 140.722 };

export const SUMMIT = { lat: 42.8750, lon: 140.6588, ele: 1308, name: 'Mt. Niseko Annupuri' };

// Quality presets — chosen in the Layers panel, stored in localStorage.
export const QUALITY = {
  ultra:    { label: 'Ultra (4K / retina)', demZoom: 14, imgZoom: 16, segments: 1024, pixelRatio: 2,   shadows: true,  maxFlakes: 80000 },
  high:     { label: 'High',                demZoom: 14, imgZoom: 15, segments: 768,  pixelRatio: 2,   shadows: true,  maxFlakes: 50000 },
  balanced: { label: 'Balanced (phones)',   demZoom: 13, imgZoom: 15, segments: 384,  pixelRatio: 1.5, shadows: false, maxFlakes: 20000 },
};

// Free, key-less tile sources (CORS enabled).
export const TILES = {
  // AWS Open Data "Terrarium" elevation tiles (Mapzen / Tilezen, mostly SRTM + GSI in Japan).
  dem: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  // Esri World Imagery satellite tiles (free for non-commercial use with attribution).
  img: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
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
