/**
 * High-performance Base64 to Uint8Array conversion.
 * Uses native Buffer.from when available (fast C++ implementation in Node.js / V8 / Cloudflare Workers),
 * avoiding slow JavaScript byte-by-byte charCodeAt loops on large file payloads.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  // Strip potential data URL prefix if present (e.g. "data:image/png;base64,")
  const commaIdx = base64.indexOf(',');
  const cleanBase64 = commaIdx !== -1 && commaIdx < 100 ? base64.slice(commaIdx + 1).trim() : base64.trim();

  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(cleanBase64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  const binaryStr = atob(cleanBase64);
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}
