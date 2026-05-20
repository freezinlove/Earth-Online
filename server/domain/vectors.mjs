import { createHash } from "node:crypto";
export { cosine } from "../../shared/domain/vector-math.mjs";

export function deterministicVector(text) {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: 64 }, (_, index) => (hash[index % hash.length] / 255) * 2 - 1);
}

