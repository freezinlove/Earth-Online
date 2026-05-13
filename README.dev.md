# Earth Online Developer Guide

Earth Online is a local-first, AI-driven travel photo archive. The app imports personal travel photos, extracts EXIF metadata, asks vision/embedding providers to understand places and scenes, groups photos into trips, resolves missing location context, and projects the result onto a 3D Earth timeline.

This document is intentionally technical. The public-facing README is `README.md`.

## Runtime Contract

- Node.js `>=24.0.0`
- npm `>=11.0.0`
- Modern Chromium-based browser for local development

The backend uses `node:sqlite`, so older Node versions are not supported.

Install Node.js on Windows:

```powershell
winget install OpenJS.NodeJS
```

Verify:

```bash
node --version
npm --version
```

## Quick Start

```bash
npm ci
npm run dev
```

Open:

```txt
http://localhost:5173/
```

`npm run dev` starts both services:

- Vite frontend: `http://localhost:5173/`
- Local API: `http://127.0.0.1:8787/`

The Vite dev server proxies `/api` and `/data` to the local API.

## Architecture

```txt
src/                    React app, UI state, i18n, feature surfaces
server/                 Local Node API, persistence, import pipeline, AI gateway
scripts/                Data generation, backup/reset, acceptance checks
public/assets/          Committed visual assets for the globe
public/data/globe/      Committed binary globe geometry/line assets
external/geodata/       Committed GeoNames SQLite database plus refresh scripts
data/                   Ignored local user library and secrets
docs/                   README artwork and project documentation assets
```

The app has two major runtime surfaces:

- Frontend: React 18, Vite, Zustand, Three.js, React Three Fiber, `three-globe`.
- Backend: Node HTTP server, SQLite persistence, local file storage, AI provider registry, geocoding and import services.

The backend is not a remote service. It is designed to run on the user's machine beside the frontend.

## Request Flow

```txt
Browser UI
  -> Vite dev proxy
  -> server/http/router.mjs
  -> application service
  -> domain projector/resolver
  -> repository + local files + optional AI/geodata
```

Important API groups:

- `/api/state`: full projected app snapshot
- `/api/import/jobs`: photo import job creation and polling
- `/api/import/jobs/:id/events`: Server-Sent Events progress stream
- `/api/settings/ai`: provider credentials and model profile settings
- `/api/geocode/reverse`: local reverse geocoding
- `/data/photos/*` and `/data/thumbs/*`: local media serving

## Data Model

Persistent state is stored in `data/earth-online.sqlite`. The repository stores JSON payloads in normalized SQLite tables:

- `trips`
- `photos`
- `place_nodes`
- `routes`
- `import_batches`
- `pending_items`
- `import_jobs`
- `meta`

Additional local files:

- `data/photos/`: imported original photos
- `data/thumbnails/`: generated thumbnails
- `data/vector-index.json`: local search/vector index
- `data/secrets/local-ai.json`: locally saved AI credentials and model settings
- `data/import-jobs/`: import job scratch/output state

Everything under `data/` is user-local and ignored by Git except `data/.gitkeep` and `data/README.md`.

## AI System

AI is optional but central to the intended experience.

Provider settings are managed in-app and saved under `data/secrets/local-ai.json`. Users do not need `.env` for normal use.

Supported provider families in the current codebase:

- Aliyun / Qwen
- OpenAI
- OpenRouter
- SiliconFlow
- Voyage
- OpenAI-compatible providers

Main backend modules:

```txt
server/ai/model-catalog.mjs
server/ai/provider-registry.mjs
server/ai/ai-config.mjs
server/ai/ai-gateway.mjs
server/ai/providers/*.mjs
server/ai/prompts/*.md
```

Primary AI jobs:

- image understanding for imported photos
- missing location/context inference
- cross-modal or text embedding for search
- retry/rebuild flow for failed embeddings

Credential resolution order:

```txt
profile-specific local credential
  -> global local credential
  -> environment variable / .env fallback
```

Environment variables still exist as advanced override hooks, but the product path is in-app configuration.

## Import Pipeline

Photo import is orchestrated by `server/application/import-service.mjs`.

High-level phases:

```txt
read/upload files
  -> hash and duplicate detection
  -> EXIF parse
  -> thumbnail generation
  -> optional AI image analysis
  -> optional embeddings
  -> trip grouping
  -> location resolution
  -> pending item creation
  -> projected state response
```

Progress is emitted through stored job events and SSE, so the UI can replay progress after refresh or reconnect.

Important defaults:

```txt
EARTH_ONLINE_IMPORT_METADATA_CONCURRENCY=16
EARTH_ONLINE_IMPORT_STORAGE_WRITE_CONCURRENCY=16
EARTH_ONLINE_IMPORT_AI_CONCURRENCY=200
EARTH_ONLINE_IMPORT_EMBEDDING_CONCURRENCY=600
EARTH_ONLINE_MISSING_INFERENCE_CONCURRENCY=200
EARTH_ONLINE_AI_IMAGE_MAX_DIMENSION=1200
EARTH_ONLINE_AI_IMAGE_JPEG_QUALITY=82
```

These are intentionally not documented in the public README. Treat them as developer tuning knobs.

## Geodata

The repository includes:

```txt
external/geodata/geonames.sqlite
```

This is a transformed GeoNames dataset used for offline reverse and forward geocoding. It is committed so a fresh clone has full local geocoding without running a heavy setup step.

Refresh it with:

```bash
npm run geodata:setup
```

That command downloads GeoNames dumps into `external/geodata/downloads/` and rebuilds `external/geodata/geonames.sqlite`.

Ignored geodata byproducts:

```txt
external/geodata/downloads/
external/geodata/*.sqlite-shm
external/geodata/*.sqlite-wal
```

If the database is missing, the app still runs, but geocoding quality is reduced.

## Globe Assets

Committed globe runtime assets:

```txt
public/assets/earth_atmos_2048.jpg
public/assets/earth_bmng_topography_5400.jpg
public/data/globe/*.bin
```

Regenerate binary globe line/land assets with:

```bash
npm run generate:globe
```

`three-globe` is consumed as an npm dependency. The local `external/three-globe/` checkout is only a reference/debug copy and remains ignored.

## Scripts

```bash
npm run dev              # Start API and Vite together
npm run frontend         # Start only Vite
npm run backend          # Start only local API
npm run build            # TypeScript build + Vite production build
npm run preview          # Preview production frontend
npm run lint             # ESLint
npm run test:backend     # Deterministic backend/domain checks
npm run test:mvp         # Local acceptance script, depends on private fixtures
npm run seed:demo        # Seed demo state
npm run data:backup      # Backup local user data
npm run data:reset       # Reset local user data
npm run data:rebuild     # Rebuild state from existing local photos
npm run geodata:setup    # Download and build GeoNames SQLite
npm run generate:globe   # Generate committed globe binary assets
```

## Quality Gates

Run before publishing or opening a PR:

```bash
npm run lint
npm run test:backend
npm run build
npm audit --audit-level=moderate
```

Current known non-fatal warnings:

- ESLint reports React Fast Refresh warnings for files that export helpers along with components.
- ESLint reports a small number of hook dependency warnings in `EarthStage.tsx`.
- Vite warns that some production chunks exceed 500 kB because the app ships a 3D/AI-heavy frontend.

These warnings are worth improving, but they do not currently block build or CI.

## Testing Notes

`npm run test:backend` is the public, CI-safe test path. It avoids private photo fixtures and validates core backend projection/resolution behavior.

`npm run test:mvp` is a local acceptance script. It expects private fixture media under:

```txt
DESIGN_SPECS/photo test/
```

It also enables the private test route:

```txt
EARTH_ONLINE_ENABLE_TEST_ROUTES=1
```

Do not add `test:mvp` to public CI unless the fixtures are replaced with redistributable test assets.

## Environment Variables

Normal users should configure AI providers inside the app. These variables are for development, automation, or advanced deployment.

Runtime paths:

```txt
EARTH_ONLINE_PORT
EARTH_ONLINE_DATA_DIR
EARTH_ONLINE_GEODATA_PATH
```

AI credentials:

```txt
ALIYUN_API_KEY
BAILIAN_API_KEY
QWEN_API_KEY
QWEN_CHAT_API_KEY
QWEN_EMBEDDING_API_KEY
OPENAI_API_KEY
OPENROUTER_API_KEY
SILICONFLOW_API_KEY
VOYAGE_API_KEY
```

AI model/runtime tuning:

```txt
QWEN_CHAT_MODEL
QWEN_REQUEST_TIMEOUT_MS
QWEN_VISION_EMBEDDING_MODEL
EARTH_ONLINE_AI_IMAGE_MAX_DIMENSION
EARTH_ONLINE_AI_IMAGE_JPEG_QUALITY
EARTH_ONLINE_MISSING_INFERENCE_CONCURRENCY
```

Import tuning:

```txt
EARTH_ONLINE_IMPORT_METADATA_CONCURRENCY
EARTH_ONLINE_IMPORT_STORAGE_WRITE_CONCURRENCY
EARTH_ONLINE_IMPORT_AI_CONCURRENCY
EARTH_ONLINE_IMPORT_EMBEDDING_CONCURRENCY
EARTH_ONLINE_FAILED_IMPORT_JOB_RETENTION_MS
```

Test-only:

```txt
EARTH_ONLINE_BASE_URL
EARTH_ONLINE_ENABLE_TEST_ROUTES
EARTH_ONLINE_TEST_CLOUD_AI
```

## Git Hygiene

Do not commit:

```txt
.env
data/
DESIGN_SPECS/
dist/
node_modules/
output/
test-results/
external/geodata/downloads/
external/geodata/*.sqlite-*
external/three-globe/
```

Expected committed binary/data files:

```txt
external/geodata/geonames.sqlite
public/assets/*.jpg
public/data/globe/*.bin
```

Use this before publishing:

```bash
git status --short --ignored
git diff --check
git ls-files | sort
```

## Release Checklist

1. Confirm `README.md` is still the public brochure and `README.dev.md` is the technical guide.
2. Run quality gates.
3. Verify `external/geodata/geonames.sqlite` passes `PRAGMA integrity_check`.
4. Confirm no personal data appears in `git status --short --ignored`.
5. Confirm third-party attribution in `THIRD_PARTY_NOTICES.md`.
6. Decide whether to add a root `LICENSE` before publishing as open source.

SQLite integrity check:

```bash
sqlite3 external/geodata/geonames.sqlite "PRAGMA integrity_check;"
```

## Desktop Packaging Notes

The project can be packaged as a desktop app, with Electron being the lowest-friction path because the backend is Node-based.

Desktop work still needs dedicated changes:

- move user data to the OS app data directory
- bundle `external/geodata/geonames.sqlite`
- start/stop the local API from Electron main
- avoid fixed API port collisions
- verify `node:sqlite` and `sharp` against the Electron runtime

Tauri is possible, but it would require more backend adaptation because the current runtime depends heavily on Node.

## Third-Party Notices

See `THIRD_PARTY_NOTICES.md` for asset, data, and dependency attribution. Keep it updated when refreshing GeoNames data, replacing Earth imagery, or changing explicit third-party runtime dependencies.
