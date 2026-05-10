# Earth_Online GeoData

This directory holds optional local geocoding data used by the server to reverse GPS coordinates into city/town/admin-area candidates.

The generated database is not committed to Git:

```txt
external/geodata/geonames.sqlite
external/geodata/downloads/
```

Build it with:

```bash
npm run geodata:setup
```

Data source:

- GeoNames: https://www.geonames.org/
- License: Creative Commons Attribution 4.0 International

The setup scripts download GeoNames text dumps and transform them into a local SQLite database for offline use.
