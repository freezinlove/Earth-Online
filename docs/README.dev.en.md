# Earth_Online Developer Guide

<p align="center">
  <a href="./README.dev.md">中文</a>
</p>

Earth_Online is a local-first, AI-driven travel photo archive. It imports personal travel photos, extracts EXIF metadata, uses optional AI providers to understand places and scenes, groups photos into trips, resolves missing location context, and projects the result onto a 3D Earth timeline.

This document is intended for developers. The user-facing guide is [README.en.md](./README.en.md).

## Runtime Contract

- Node.js `>=24.0.0`
- npm `>=11.0.0`
- Windows is the primary desktop packaging target.
- Modern Chromium-based browser for Web development.

The backend uses recent Node runtime capabilities. Use Node 24+ unless you are deliberately testing compatibility.

Install Node.js on Windows:

```powershell
winget install OpenJS.NodeJS
```

Verify:

```bash
node --version
npm --version
```

Install dependencies:

```bash
npm ci
```

## Development Modes

### Desktop Dev, Recommended For Product Work

```bash
npm run electron:dev
```

This starts:

- Vite frontend on `http://127.0.0.1:5173/`
- Electron desktop shell
- Local API from Electron main process

Use this mode when testing behavior intended for normal users, including:

- native directory picker
- first-run data storage selection
- desktop onboarding persistence
- local API token protection
- packaged-app navigation behavior

If you want dev desktop config isolated from the installed desktop app, start it with a separate Electron config directory:

```powershell
$env:EARTH_ONLINE_USER_DATA_DIR="X:\Earth_Online_Dev_Config"
npm run electron:dev
```

Then choose a real data directory inside the app, for example:

```text
X:\Earth_Online_Dev_Data
```

### Web Dev

```bash
npm run dev
```

This starts:

- Vite frontend: `http://localhost:5173/`
- Local API: `http://127.0.0.1:8787/`

The Vite dev server proxies `/api` and `/data` to the local API.

The Web dev build cannot open a native system folder picker. It can display the current data directory, but it cannot change it from the UI. To change the Web dev data directory, set `EARTH_ONLINE_DATA_DIR` before startup:

```powershell
$env:EARTH_ONLINE_DATA_DIR="X:\Earth_Online_Web_Data"
npm run dev
```

If `http://localhost:5173/` opens but storage or settings do not load, check that the API is also running:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/settings/storage
```

### Split Frontend And Backend

```bash
npm run backend
npm run frontend
```

Use this only when you need to debug one side independently. For normal work, prefer `npm run dev` or `npm run electron:dev`.

## Desktop Packaging

Build the unpacked desktop app and Windows installer:

```bash
npm run electron:dist
```

Outputs:

```text
release/win-unpacked/Earth Online.exe
release/Earth Online Setup 0.1.0.exe
```

Build only the unpacked app:

```bash
npm run electron:pack
```

Smoke test the packaged app:

```bash
npm run electron:smoke
```

The smoke test checks packaged startup, API access, desktop token enforcement, asset serving, import basics, onboarding persistence, and storage configuration behavior.

## Data Storage

Earth_Online has two different storage concepts.

### Actual App Data Directory

This stores user data:

```text
db.json
photos/
thumbnails/
vector-index.json
import-jobs/
secrets/local-ai.json
earth-online-data.json
```

It contains personal photos, generated thumbnails, local app state, vector search data, import job state, and locally saved AI credentials.

Web dev default:

```text
data/
```

Web dev override:

```powershell
$env:EARTH_ONLINE_DATA_DIR="X:\Earth_Online_Web_Data"
npm run dev
```

Electron desktop behavior:

- On first desktop launch, the app asks the user to choose a data directory.
- The selected path is saved in Electron preferences.
- Switching data directory from settings requires restart.
- Current version does not migrate existing data automatically.
- If `EARTH_ONLINE_DATA_DIR` is set, it overrides the UI choice and disables the directory picker.

### Electron Config Directory

Electron also keeps a small config/cache directory. On Windows, the default packaged path is typically:

```text
C:\Users\<User>\AppData\Roaming\earth-online
```

This stores Electron preferences, cache, onboarding completion state, and the pointer to the selected app data directory. It should remain small. Do not put large imported photo data here unless the user explicitly chooses the default app data directory.

For dev isolation:

```powershell
$env:EARTH_ONLINE_USER_DATA_DIR="X:\Earth_Online_Dev_Config"
npm run electron:dev
```

## Architecture

```text
src/                    React app, UI state, i18n, feature surfaces
electron/               Electron main/preload/dev launcher
server/                 Local Node API, persistence, import pipeline, AI gateway
scripts/                Data generation, backup/reset, packaging checks
public/assets/          Committed visual assets for the globe
public/data/globe/      Committed binary globe geometry/line assets
external/geodata/       Committed GeoNames SQLite database plus refresh scripts
data/                   Default ignored Web dev data directory
docs/                   README artwork and project documentation assets
release/                Ignored generated desktop artifacts
output/                 Ignored logs, smoke-test data, temporary output
```

Major runtime surfaces:

- Frontend: React 18, Vite, Zustand, Three.js, React Three Fiber, `three-globe`.
- Backend: Node HTTP server, local file storage, AI provider registry, geocoding, import services.
- Desktop: Electron main process, native folder picker, desktop preferences, packaged API startup.

The backend is not a remote service. It runs on the user's machine beside the frontend or inside the Electron desktop process.

## Request Flow

Web dev:

```text
Browser UI
  -> Vite dev proxy
  -> server/http/router.mjs
  -> application service
  -> repository + local files + optional AI/geodata
```

Desktop:

```text
Electron renderer
  -> preload desktop bridge
  -> local API with desktop token
  -> server/http/router.mjs
  -> application service
  -> selected data directory + optional AI/geodata
```

Important API groups:

- `/api/state`: full projected app snapshot
- `/api/import/jobs`: photo import job creation and polling
- `/api/import/jobs/:id/events`: Server-Sent Events progress stream
- `/api/settings/ai`: provider credentials and model profile settings
- `/api/settings/storage`: current storage paths
- `/api/geocode/reverse`: local reverse geocoding
- `/data/photos/*` and `/data/thumbs/*`: local media serving

## Data Model

Persistent state is stored under the active app data directory. The current backend path names are:

- `db.json`: local app state
- `photos/`: imported original photos
- `thumbnails/`: generated thumbnails
- `vector-index.json`: local search/vector index
- `secrets/local-ai.json`: locally saved AI credentials and model settings
- `import-jobs/`: import job scratch/output state

Everything under the default `data/` directory is user-local and ignored by Git except `data/.gitkeep` and `data/README.md`.

## AI System

AI is optional but central to the intended experience.

Provider settings are managed in-app and saved under the active data directory:

```text
secrets/local-ai.json
```

Users do not need `.env` for normal use.

Supported provider families in the current codebase:

- Aliyun / Qwen
- OpenAI
- OpenRouter
- SiliconFlow
- Voyage
- OpenAI-compatible providers

Main backend modules:

```text
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

```text
profile-specific local credential
  -> global local credential
  -> environment variable / .env fallback
```

Environment variables still exist as advanced override hooks, but the product path is in-app configuration.

## Import Pipeline

Photo import is orchestrated by `server/application/import-service.mjs`.

High-level phases:

```text
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

```text
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

```text
external/geodata/geonames.sqlite
```

This is a transformed GeoNames dataset used for offline reverse and forward geocoding. It is committed so a fresh clone has local geocoding without running a heavy setup step.

Refresh it with:

```bash
npm run geodata:setup
```

That command downloads GeoNames dumps into `external/geodata/downloads/` and rebuilds `external/geodata/geonames.sqlite`.

Ignored geodata byproducts:

```text
external/geodata/downloads/
external/geodata/*.sqlite-shm
external/geodata/*.sqlite-wal
```

If the database is missing, the app still runs, but geocoding quality is reduced.

## Globe Assets

Committed globe runtime assets:

```text
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
npm run dev              # Start Web dev frontend and API together
npm run electron:dev     # Start Electron desktop dev mode
npm run electron:pack    # Build unpacked desktop app
npm run electron:dist    # Build unpacked desktop app and Windows installer
npm run electron:smoke   # Smoke test packaged desktop app
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
npm run electron:smoke
npm audit --audit-level=moderate
```

Run `npm run electron:dist` before `npm run electron:smoke` when the packaged output needs to reflect current source changes.

Current known non-fatal warnings:

- ESLint reports React Fast Refresh warnings for files that export helpers along with components.
- ESLint reports a small number of hook dependency warnings in `EarthStage.tsx`.
- Vite warns that some production chunks exceed 500 kB because the app ships a 3D/AI-heavy frontend.

These warnings are worth improving, but they do not currently block build or packaging.

## Testing Notes

`npm run test:backend` is the public, CI-safe test path. It avoids private photo fixtures and validates core backend projection/resolution behavior.

`npm run electron:smoke` validates the generated desktop app under `release/win-unpacked/`. It expects that package to exist.

`npm run test:mvp` is a local acceptance script. It expects private fixture media under:

```text
DESIGN_SPECS/photo test/
```

It also enables the private test route:

```text
EARTH_ONLINE_ENABLE_TEST_ROUTES=1
```

Do not add `test:mvp` to public CI unless the fixtures are replaced with redistributable test assets.

## Environment Variables

Normal users should configure AI providers and desktop data storage inside the app. These variables are for development, automation, or advanced deployment.

Runtime paths:

```text
EARTH_ONLINE_PORT
EARTH_ONLINE_DATA_DIR
EARTH_ONLINE_USER_DATA_DIR
EARTH_ONLINE_GEODATA_PATH
ELECTRON_DEV_SERVER_URL
```

Desktop/runtime security:

```text
EARTH_ONLINE_DESKTOP
EARTH_ONLINE_DESKTOP_TOKEN
```

AI credentials:

```text
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

```text
QWEN_CHAT_MODEL
QWEN_REQUEST_TIMEOUT_MS
QWEN_VISION_EMBEDDING_MODEL
EARTH_ONLINE_AI_IMAGE_MAX_DIMENSION
EARTH_ONLINE_AI_IMAGE_JPEG_QUALITY
EARTH_ONLINE_MISSING_INFERENCE_CONCURRENCY
```

Import tuning:

```text
EARTH_ONLINE_IMPORT_METADATA_CONCURRENCY
EARTH_ONLINE_IMPORT_STORAGE_WRITE_CONCURRENCY
EARTH_ONLINE_IMPORT_AI_CONCURRENCY
EARTH_ONLINE_IMPORT_EMBEDDING_CONCURRENCY
EARTH_ONLINE_FAILED_IMPORT_JOB_RETENTION_MS
```

Test-only:

```text
EARTH_ONLINE_BASE_URL
EARTH_ONLINE_ENABLE_TEST_ROUTES
EARTH_ONLINE_TEST_CLOUD_AI
EARTH_ONLINE_SMOKE_DATA_DIR
EARTH_ONLINE_SMOKE_RENDERER_REPORT
EARTH_ONLINE_SMOKE_MARK_ONBOARDING_COMPLETE
EARTH_ONLINE_SMOKE_INITIAL_STORAGE_FLOW
```

## Git Hygiene

Do not commit:

```text
.env
data/
DESIGN_SPECS/
dist/
node_modules/
output/
release/
test-results/
external/geodata/downloads/
external/geodata/*.sqlite-*
external/three-globe/
```

Expected committed binary/data files:

```text
external/geodata/geonames.sqlite
public/assets/*.jpg
public/data/globe/*.bin
docs/gugugaga.png
docs/gugugaga.ico
```

Use this before publishing:

```bash
git status --short --ignored
git diff --check
git ls-files | sort
```

## Release Checklist

1. Confirm [README.en.md](./README.en.md) is still the public user guide and this file is the technical guide.
2. Run quality gates.
3. Run `npm run electron:dist`.
4. Run `npm run electron:smoke`.
5. Verify `external/geodata/geonames.sqlite` passes `PRAGMA integrity_check`.
6. Confirm no personal data appears in `git status --short --ignored`.
7. Confirm third-party attribution in `THIRD_PARTY_NOTICES.md`.
8. Decide whether to add a root `LICENSE` before publishing as open source.

SQLite integrity check:

```bash
sqlite3 external/geodata/geonames.sqlite "PRAGMA integrity_check;"
```

## Troubleshooting

### Web dev page opens but storage/settings fail

Check that the API is running:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/settings/storage
```

If only port `5173` is listening, stop the stale frontend process and restart `npm run dev`.

### Desktop dev reads packaged app data

Use a separate Electron config directory:

```powershell
$env:EARTH_ONLINE_USER_DATA_DIR="X:\Earth_Online_Dev_Config"
npm run electron:dev
```

### UI directory picker is disabled

Check whether `EARTH_ONLINE_DATA_DIR` is set. In Electron, this environment variable intentionally overrides the UI-selected directory and disables the picker.

### Packaged app shows stale UI

Rebuild the desktop package:

```bash
npm run electron:dist
```

Then launch:

```text
release/win-unpacked/Earth Online.exe
```

## Third-Party Notices

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for asset, data, and dependency attribution. Keep it updated when refreshing GeoNames data, replacing Earth imagery, or changing explicit third-party runtime dependencies.
