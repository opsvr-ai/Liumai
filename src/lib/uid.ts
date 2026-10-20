/* ==========================================================================
 *  Unique id helper — safe in every context
 *
 *  ``crypto.randomUUID`` only exists in **secure contexts** (HTTPS or
 *  localhost).  The platform is frequently opened over plain HTTP on an
 *  intranet address (e.g. ``http://192.168.1.10:3000``), where the call is
 *  simply ``undefined`` and throws ``TypeError: crypto.randomUUID is not a
 *  function``.  Callers used it while building chat messages, so the throw
 *  happened before ``fetch`` and the turn vanished without a request, a
 *  backend log line or an error in the UI.
 *
 *  ``uid()`` never throws: it prefers ``crypto.randomUUID`` when available and
 *  otherwise returns a UUID-v4-shaped string built from ``Date.now()`` and
 *  ``Math.random()``.  Collision safety only matters for React keys / local
 *  message ids, so the timestamp prefix plus 26 random hex digits is ample.
 * ========================================================================== */

/** UUID v4 string, using ``crypto.randomUUID`` when the context allows it. */
export function uid(): string {
  const cryptoApi: Crypto | undefined =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Some embedded browsers expose the method but throw on call — fall back.
    }
  }
  return fallbackUuidV4();
}

/** UUID-v4-shaped fallback (8-4-4-4-12) seeded by the clock and Math.random. */
function fallbackUuidV4(): string {
  // 41 bits of milliseconds (12 hex chars) + random hex, padded to 32.
  const seed =
    Date.now().toString(16).padStart(12, "0").slice(-12) +
    randomHex(20);
  const hex = seed.padEnd(32, "0").slice(0, 32);
  // Version nibble 4 and RFC 4122 variant (8, 9, a or b).
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** Lowercase hex string of exactly *length* characters. */
function randomHex(length: number): string {
  let out = "";
  while (out.length < length) {
    out += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, "0");
  }
  return out.slice(0, length);
}
