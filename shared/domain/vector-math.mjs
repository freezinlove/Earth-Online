export function cosine(a, b) {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index];
    an += a[index] * a[index];
    bn += b[index] * b[index];
  }
  return an && bn ? dot / (Math.sqrt(an) * Math.sqrt(bn)) : 0;
}
