// Compact JWS signing with Node's built-in crypto: RS256 for the Google service
// account assertion, ES256 for the App Store Connect API token. All key
// material stays in memory; nothing is written to disk.

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export type Signer = (signingInput: Buffer) => Buffer;

export function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** Build a compact JWS. `signer` maps the signing input bytes to a signature. */
export function buildJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  signer: Signer,
): string {
  const segments = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${segments}.${b64url(signer(Buffer.from(segments)))}`;
}

/** RS256: RSASSA-PKCS1-v1_5 with SHA-256 (Node's default for RSA keys). */
export function rs256Signer(key: KeyObject): Signer {
  return (data) => sign("sha256", data, key);
}

/** ES256. JOSE wants the raw fixed-width r || s (64 bytes for P-256), not the
 * DER encoding Node produces by default, hence `ieee-p1363`. */
export function es256Signer(key: KeyObject): Signer {
  return (data) => sign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
}

const PEM_HEADER = "-----BEGIN";

/**
 * Load an App Store Connect API key (.p8). Accepts any of:
 *   - the raw PEM text (as pasted from the .p8 file),
 *   - the PEM with literal "\n" escapes (a common artefact of pasting into a
 *     single-line secret),
 *   - base64 of the whole .p8 file (`base64 -i AuthKey_XXX.p8`),
 *   - base64 of the DER body alone (the lines between the PEM headers).
 */
export function loadP8(input: string): KeyObject {
  const text = normalisePem(input);
  let key: KeyObject;
  if (text.includes(PEM_HEADER)) {
    key = createPrivateKey(text);
  } else {
    const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64");
    const asText = normalisePem(decoded.toString("utf8"));
    key = asText.includes(PEM_HEADER)
      ? createPrivateKey(asText)
      : createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
  }
  if (key.asymmetricKeyType !== "ec") {
    throw new Error(`App Store Connect key must be an EC (P-256) key, got ${key.asymmetricKeyType ?? "unknown"}`);
  }
  return key;
}

function normalisePem(value: string): string {
  return value.trim().replace(/\\n/g, "\n");
}
