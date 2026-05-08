import { resetDataDir, saveEmptyState } from "./data_utils.mjs";

const deleteFiles = !process.argv.includes("--keep-files");

await resetDataDir({ deleteFiles });
await saveEmptyState();
console.log(deleteFiles ? "Local user data reset; photos and thumbnails removed." : "Local user data reset; existing photos and thumbnails kept.");
