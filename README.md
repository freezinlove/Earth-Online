<p align="center">
  <img src="./docs/hero.png" alt="Earth Online travel archive hero artwork" width="900" />
</p>

<p align="center">
  <a href="./docs/README.zh.md">中文</a>
</p>

<h1 align="center">A Travel Gift, Made for You</h1>

<p align="center">
  An automated private travel planet powered by AI.
</p>

<p align="center">
  Earth_Online automatically understands your photos, recognizes the places in your trips, organizes time and routes, and brings scattered memories back to life on a 3D Earth, timeline, and travel archive.
</p>

<br />

## Recommended Usage

### Desktop App

Regular users should use the desktop installer when possible. You do not need to manually start frontend or backend services.

Get the installer from the Releases section on the right, then run it directly:

```text
Earth Online Setup 0.1.3.exe
```

### Android App

An Android APK is also available from Releases:

```text
Earth Online Android 1.0-release.apk
```

The Android version uses the same visual design and main workflow as the desktop app. Some touch interactions are not fully optimized yet, so if you have access to a desktop environment, the desktop app is still the recommended experience.

## Usage Tips

- Prefer importing photos with GPS metadata.
- Photos without GPS can be resolved using nearby photo context.
- Embedding is optional. Browsing and organizing photos still works without it.
- Try clicking the timeline frequently. It is one of the main ways to explore the archive.
- Photo import speed depends heavily on local network speed and cloud model provider throughput, so long-tail slowdowns are expected.
- A single import batch supports up to 1000 photos. I personally recommend 400 or fewer photos per batch because larger batches have not been tested enough.
- On Android, keep each import batch to 40 photos or fewer. Larger batches may feel sluggish during import processing.

## Brief Developer Notes

Development and local debugging require Node.js `24+` and npm `11+`.

```powershell
winget install OpenJS.NodeJS
```

On macOS / Linux, install Node.js `24+` from the Node.js website or through nvm.

Install dependencies:

```bash
npm ci
```

Start desktop development mode:

```bash
npm run electron:dev
```

Start Web development mode:

```bash
npm run dev
```

The Web development build opens `http://localhost:5173/`, but browsers cannot directly choose a system data directory. To change the data directory, set `EARTH_ONLINE_DATA_DIR` before startup.

For full development, packaging, testing, and data-directory documentation, see [docs/README.dev.en.md](./docs/README.dev.en.md).
