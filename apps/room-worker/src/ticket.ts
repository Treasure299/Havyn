import type { RoomTicketClaims } from "./protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBase64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signTicket(claims: RoomTicketClaims, secret: string): Promise<string> {
  const body = encodeBase64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyTicket(token: string, secret: string): Promise<RoomTicketClaims | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    decodeBase64Url(signature),
    encoder.encode(body)
  );
  if (!valid) return null;
  const claims = JSON.parse(decoder.decode(decodeBase64Url(body))) as RoomTicketClaims;
  if (!claims.userId || !claims.roomId || claims.exp <= Date.now()) return null;
  return claims;
}
