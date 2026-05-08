import fs from "node:fs/promises";
import { EarthRepository } from "../server/repository.mjs";
import { dataDir, dbPath, photoDir, thumbDir, vectorPath } from "../server/config/paths.mjs";
import { seedState } from "../server/seed.mjs";

await fs.mkdir(photoDir, { recursive: true });
await fs.mkdir(thumbDir, { recursive: true });
const repository = new EarthRepository({ dataDir, dbJsonPath: dbPath });
await repository.ensureInitialized();
repository.saveState(seedState);
repository.close();
await fs.writeFile(vectorPath, JSON.stringify(seedState.vectorIndex ?? {}, null, 2), "utf8");
console.log("Demo seed data written to local data directory.");
