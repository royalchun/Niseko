# ❄️ Niseko Snow 3D

A live 3D weather & snow simulator for **Niseko United** — Annupuri, Niseko Village, Grand Hirafu and Hanazono — built to share with friends planning a ski trip.

- **Live weather in 3D** — falling snow / rain, wind drift, clouds, fog and real sun position, driven by the current forecast for each resort base and the summit.
- **Detailed terrain** — Japan's official GSI **5 m elevation model** (vs 30 m SRTM) with a 5 m lighting map, GSI aerial photos, and an extra-sharp photo patch (≈0.6 m/pixel) that loads wherever you zoom in.
- **Snow on the ground** — snow depth from the weather model, spread over the terrain by elevation; cliffs shed snow, lee slopes collect wind-blown snow, the surface has wind ripples (sastrugi), and fresh snow sparkles in the sun.
- **Snowfall** — three layers: distant snow, detailed six-armed flakes around the camera, and spindrift blowing along the ground in strong wind. Flakes stop where they hit the terrain.
- **Checkpoints** — 20 on-mountain spots (e.g. Hanazono 308, Boyoso, 1000m Hut, the summit) plus your own: live weather at that exact elevation, feels-like temperature, 48 h chart, sun/shade times from the real terrain horizon, slope & aspect, nearest lifts (with queue estimate) and runs, and an eye-level "Stand here" view.
- **Time travel** — drag the timeline through the past 14 days and next 16 days; the storm and the snowpack update as you scrub.
- **30-day snow forecast** — multi-model blend (JMA, ECMWF, ICON, GFS) → ECMWF 51-member ensemble → 10-season climatology, weighted by lead time, with uncertainty bands, powder probabilities and snow quality.
- **Lift-queue estimate** — a transparent heuristic model (holiday peaks, weekday, hour, powder-day rush, wind holds). *Not live data* — see below.
- **Google-Earth-style controls** — drag/pinch, fly-to buttons, double-click to zoom, compass, minimap, keyboard shortcuts, shareable view links, high-res screenshots.
- Real lifts (34) and ski runs (213) from OpenStreetMap, draped on the terrain.

## Run locally

It's a static site (no build step, no API keys):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Put it online (free)

**GitHub Pages** (recommended): merge to `main`, then in the repo go to *Settings → Pages → Source: GitHub Actions*. The workflow in `.github/workflows/pages.yml` deploys automatically and your link will be `https://<user>.github.io/<repo>/`.
> GitHub Pages on a **private** repo needs a paid plan — make the repo public, or use one of the options below.

**Alternatives:** drag the folder onto [Netlify Drop](https://app.netlify.com/drop), or connect the repo to Cloudflare Pages / Vercel (framework preset: *None*, output dir: `/`).

## Data sources (all free)

| What | Source | Notes |
|---|---|---|
| Hourly weather, snow depth, freezing level | [Open-Meteo Forecast API](https://open-meteo.com/en/docs) | No key. Free for non-commercial use, ~10 000 calls/day per user. |
| Multi-model forecast | Open-Meteo (`jma_seamless`, `ecmwf_ifs025`, `icon_seamless`, `gfs_seamless`) | JMA is the most detailed model over Hokkaido. |
| Ensemble | [Open-Meteo Ensemble API](https://open-meteo.com/en/docs/ensemble-api) | ECMWF IFS 51 members. |
| Climatology | [Open-Meteo Historical API](https://open-meteo.com/en/docs/historical-weather-api) | ERA5 reanalysis, last 10 seasons. |
| Elevation | [GSI Tiles 地理院タイル](https://maps.gsi.go.jp/development/ichiran.html) `dem5c_png` (5 m), `dem_png` (10 m) | Geospatial Information Authority of Japan, free with attribution. Fallback: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/). |
| Aerial photos | GSI `seamlessphoto` | Sharpest free imagery for Japan. Fallback: Esri World Imagery (© Esri, Maxar). |
| Lifts, runs, peaks, restaurants | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL) | Baked into `data/niseko-osm.json`. |

Responses are cached in the browser (30 min – 7 days) to stay well inside the free limits.

Other free sources worth knowing: [JMA AMeDAS](https://www.jma.go.jp/bosai/amedas/) (observed snow depth at Kutchan station), [Niseko United official site](https://www.niseko.ne.jp/en/) (lift status, webcams), [snow-forecast.com](https://www.snow-forecast.com/resorts/Niseko/6day/mid) (for comparison).

## About lift queues

No free or public API publishes Niseko lift queue lengths. Niseko United publishes **lift open/closed status** and **webcams** on its official site, but not queue times, and the site can't be read from a browser app (CORS). The queue panel is therefore an **estimate** with its reasons listed. The peak-period calendar lives at the top of `js/crowd.js` — update it each season.

## Project layout

```
index.html           UI shell
css/style.css        styles (dark glass UI, mobile layout)
js/config.js         area, resorts, quality presets, data URLs
js/terrain.js        tile stitching, 3D mesh, snow-cover shader
js/overlays.js       lifts, runs, labels
js/checkpoints.js    checkpoint pins, detail cards, eye-level view
js/effects.js        sky, sun, fog, clouds, snow/rain particles
js/weather.js        Open-Meteo fetching + caching
js/forecast.js       snow prediction model + chart
js/crowd.js          lift queue estimator
js/main.js           app wiring, controls, timeline, panels
data/niseko-osm.json lifts & runs (OpenStreetMap)
```
