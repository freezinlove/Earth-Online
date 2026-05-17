export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}
