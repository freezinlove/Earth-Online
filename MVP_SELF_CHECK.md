# Earth_Online MVP Self Check

Last updated: 2026-04-28

## P0 Closed Loops

- Local multi-photo import: implemented through `/api/import`, including browser file and folder selection.
- Apple test import: implemented through `/api/import/apple-test` for `DESIGN_SPECS/photo test/apple`.
- App-managed storage: imported images are copied into `output/earth-online-data/photos`.
- EXIF time/GPS: JPEG EXIF DateTimeOriginal and GPS are parsed; missing GPS/time create pending state.
- Qwen provider: real Qwen/Bailian path is implemented with local mock fallback; normal user imports and Apple test reanalysis use cloud AI when the setting is enabled.
- AI observability: import batches record Qwen/fallback counts and Qwen/deterministic embedding counts; photos record AI provider, embedding provider, and embedding dimension.
- Import batch: created for each import with summary, added photo IDs, created trip IDs, pending IDs, duplicate count, and rollback metadata.
- Confirm/rollback: latest pending import can be confirmed or rolled back, including files and vector index entries.
- Multi-trip split/merge: obvious time gaps create multiple Trip drafts; import confirmation can merge them back into one Trip.
- Duplicate handling: identical file hashes are skipped instead of duplicated.
- Trip archive: clicking a trip opens the archive detail/photos view, not the globe.
- Trip detail: shows grouped photos, places, pending items, editable title and dates.
- Photo correction: photo time, GPS coordinates, and tags can be manually corrected.
- Manual fallback: users can create trips, create places, bind unlocated photos, reorder places, and delete bad places.
- Route update: imported routes are rebuilt from time-ordered GPS photo points; manual routes still rebuild from place order.
- 3D globe: shows route, place nodes, and individual photo points for selected trip; markers and route arcs are kept close to the globe surface.
- Globe/timeline linkage: selecting trip/photo/place updates cursor and selected state; the timeline supports global, day, and photo levels.
- Search: backend search uses metadata, tags, place/trip/date/file filters, and vector scoring.
- SQLite repository: current data is stored in `output/earth-online-data/earth-online.sqlite`, with one table per core object and vector index kept in a separate file.
- Thumbnail storage: browser imports generate resized JPEG thumbnails before upload; backend stores originals and thumbnails separately.
- Import progress: browser import shows read/thumbnail progress and backend analysis phase.
- Import jobs: `/api/import/jobs` and `/api/import/jobs/:id` provide an async import job path for long-running imports, persisted into SQLite.
- Automated MVP checks: `npm run test:mvp` verifies storage, import, EXIF, split/merge, rollback, search, and manual APIs.
- Bundle split: Vite separates React, icons, app code, and Three/R3F chunks.
- Apple test data repair: previous mock/Kyoto Apple test records are migrated to GPS-aware European/Prague metadata and rebuilt into multiple place nodes and connected route points.

## Still Needs Hardening

- Expose fine-grained backend progress events for EXIF, thumbnail, and AI phases.
- Add automated browser tests for the full 18-point MVP acceptance list.
- Replace object-payload SQLite tables with fully columnized tables and migrations when scale requires it.
