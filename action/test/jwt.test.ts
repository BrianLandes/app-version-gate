import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ascToken } from "../src/appstore.js";
import type { Http, HttpRequest } from "../src/http.js";
import { loadP8 } from "../src/jwt.js";
import { ANDROID_SCOPE, googleAccessToken, parseServiceAccount } from "../src/play.js";

function decode(token: string) {
  const [header, claims, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString()) as Record<string, unknown>,
    signingInput: Buffer.from(`${header}.${claims}`),
    signature: Buffer.from(signature!, "base64url"),
  };
}

describe("ES256 (App Store Connect)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  it("signs with a raw 64-byte r||s signature, not DER", () => {
    const token = ascToken("KEY123", "issuer-uuid", loadP8(pem), 1_700_000_000);
    const { header, claims, signingInput, signature } = decode(token);
    expect(header).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(claims).toEqual({ iss: "issuer-uuid", iat: 1_700_000_000, exp: 1_700_000_600, aud: "appstoreconnect-v1" });
    expect(signature.length).toBe(64);
    expect(verify("sha256", signingInput, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });

  it("accepts the .p8 as PEM, escaped PEM, base64 of the file, or base64 of the DER body", () => {
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const forms = [
      pem,
      pem.replace(/\n/g, "\\n"),
      Buffer.from(pem).toString("base64"),
      der.toString("base64"),
    ];
    for (const form of forms) {
      const key = loadP8(form);
      expect(createPublicKey(key).export({ format: "der", type: "spki" })).toEqual(
        publicKey.export({ format: "der", type: "spki" }),
      );
    }
  });

  it("rejects a non-EC key and garbage", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => loadP8(rsa)).toThrow(/EC/);
    expect(() => loadP8("not a key")).toThrow();
  });
});

describe("RS256 (Google service account)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    client_email: "ci@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    token_uri: "https://oauth2.example/token",
  };

  it("exchanges a correctly signed assertion for an access token", async () => {
    const calls: HttpRequest[] = [];
    const http: Http = async (request) => {
      calls.push(request);
      return { access_token: "ya29.token" };
    };
    expect(await googleAccessToken(http, parseServiceAccount(JSON.stringify(account)), 1_700_000_000)).toBe("ya29.token");
    expect(calls[0]!.url).toBe("https://oauth2.example/token");
    const form = new URLSearchParams(calls[0]!.body!);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const { header, claims, signingInput, signature } = decode(form.get("assertion")!);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toEqual({
      iss: account.client_email,
      scope: ANDROID_SCOPE,
      aud: account.token_uri,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(verify("sha256", signingInput, publicKey, signature)).toBe(true);
  });

  it("rejects a service account without a key", () => {
    expect(() => parseServiceAccount('{"client_email":"x"}')).toThrow(/private_key/);
  });
});
