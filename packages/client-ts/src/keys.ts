import { sha256, toBase64Url, utf8 } from "./encoding.js";

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface PrivateJwk extends PublicJwk {
  d: string;
}

export interface HiveKeypair {
  publicKey: PublicJwk;
  /** Never leaves this machine. The Hive only ever sees `publicKey`. */
  privateKey: PrivateJwk;
  /** RFC 7638 JWK thumbprint of the public key. Used as the signature `keyid`. */
  thumbprint: string;
}

/** RFC 7638 thumbprint of an Ed25519 public JWK, base64url. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  return toBase64Url(await sha256(utf8(`{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`)));
}

/** Generates an Ed25519 keypair locally with Web Crypto. */
export async function generateKeypair(): Promise<HiveKeypair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as { privateKey: CryptoKey };
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { x?: string; d?: string };
  if (!jwk.x || !jwk.d) throw new Error("Ed25519 key export failed");
  const publicKey: PublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  return {
    publicKey,
    privateKey: { ...publicKey, d: jwk.d },
    thumbprint: await jwkThumbprint(publicKey),
  };
}
