import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedState } from "./seed.mjs";

const tableMap = {
  trips: "trips",
  photos: "photos",
  placeNodes: "place_nodes",
  routes: "routes",
  importBatches: "import_batches",
  pendingItems: "pending_items",
};

export class EarthRepository {
  constructor({ dataDir, dbJsonPath }) {
    this.sqlitePath = path.join(dataDir, "earth-online.sqlite");
    this.dbJsonPath = dbJsonPath;
    this.db = new DatabaseSync(this.sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS place_nodes (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS import_batches (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS pending_items (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS import_jobs (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_photos_payload ON photos(id);
      CREATE INDEX IF NOT EXISTS idx_import_batches_payload ON import_batches(id);
    `);
  }

  isInitialized() {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get("initialized")?.value === "1";
  }

  async ensureInitialized() {
    if (this.isInitialized()) return;
    let state = seedState;
    if (existsSync(this.dbJsonPath)) {
      try {
        state = JSON.parse(await fs.readFile(this.dbJsonPath, "utf8"));
      } catch {
        state = seedState;
      }
    }
    this.saveState({ ...state, vectorIndex: undefined });
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run("initialized", "1");
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run("schema_version", "1");
  }

  readState() {
    const state = {};
    for (const [key, table] of Object.entries(tableMap)) {
      state[key] = this.db
        .prepare(`SELECT payload FROM ${table} ORDER BY id`)
        .all()
        .map((row) => JSON.parse(row.payload));
    }
    return state;
  }

  saveState(state) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, table] of Object.entries(tableMap)) {
        this.db.prepare(`DELETE FROM ${table}`).run();
        const insert = this.db.prepare(`INSERT INTO ${table}(id, payload, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)`);
        for (const item of Array.isArray(state[key]) ? state[key] : []) {
          insert.run(item.id, JSON.stringify(item));
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveImportJob(job) {
    this.db
      .prepare("INSERT OR REPLACE INTO import_jobs(id, payload, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)")
      .run(job.id, JSON.stringify(job));
  }

  getImportJob(id) {
    const row = this.db.prepare("SELECT payload FROM import_jobs WHERE id = ?").get(id);
    return row ? JSON.parse(row.payload) : undefined;
  }
}
