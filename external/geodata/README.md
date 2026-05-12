# Earth_Online GeoData

This directory holds local geocoding data used by the server to reverse GPS coordinates into city/town/admin-area candidates.

The bundled database is committed to Git:

```txt
external/geodata/geonames.sqlite
```

The download cache and SQLite sidecar files are not committed:

```txt
external/geodata/downloads/
external/geodata/*.sqlite-*
```

Refresh the database with:

```bash
npm run geodata:setup
```

Data source:

- GeoNames: https://www.geonames.org/
- License: Creative Commons Attribution 4.0 International
- License URL: https://creativecommons.org/licenses/by/4.0/

The setup scripts download GeoNames text dumps and transform them into a local SQLite database for offline use.
