import { createHash } from "node:crypto";

export function deterministicVector(text) {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: 64 }, (_, index) => (hash[index % hash.length] / 255) * 2 - 1);
}

export function cosine(a, b) {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  return an && bn ? dot / (Math.sqrt(an) * Math.sqrt(bn)) : 0;
}
