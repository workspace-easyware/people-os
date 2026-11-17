// 캘린더 C3 (2026-11-17): 구글 토큰 암호화. 계획서 calendar-plan.md 2.4.
// Web Crypto AES-256-GCM. 키 = 시크릿 GCAL_TOKEN_KEY (32바이트를 base64로). 암호화마다 무작위 12바이트 IV.
// AAD = 'people-os:gcal:v1:<user_id>:<purpose>' → 한 사용자의 암호문을 다른 사용자 행(또는 다른 용도 칸)에
// 붙여 넣으면 복호화가 실패한다. 저장 형식: 'v1.<base64url IV>.<base64url 암호문(태그 포함)>'.
// 이 파일은 평문·키를 로그에 찍지 않는다. 실패는 전부 CryptoError(메시지에 비밀 없음).

export type TokenPurpose = "refresh" | "access" | "pkce";

const VERSION = "v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

export class CryptoError extends Error {}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new CryptoError("bad base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 표준 base64(시크릿 형식) → 바이트. 형식이 틀리면 null. */
function b64Decode(text: string): Uint8Array | null {
  try {
    const bin = atob(text.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 시크릿이 32바이트 base64로 디코드되는지 (미설정·형식 오류면 false → 호출자가 503). */
export function tokenKeyValid(secret: string | undefined): boolean {
  if (!secret) return false;
  const raw = b64Decode(secret);
  return !!raw && raw.length === 32;
}

// 같은 isolate 안에서 importKey를 반복하지 않는다 (시크릿 문자열 → CryptoKey).
let cachedSecret: string | null = null;
let cachedKey: CryptoKey | null = null;

async function importKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new CryptoError("GCAL_TOKEN_KEY missing");
  if (cachedKey && cachedSecret === secret) return cachedKey;
  const raw = b64Decode(secret);
  if (!raw || raw.length !== 32) throw new CryptoError("GCAL_TOKEN_KEY must be 32 bytes (base64)");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  cachedSecret = secret;
  cachedKey = key;
  return key;
}

function aad(userId: string, purpose: TokenPurpose): Uint8Array {
  if (!userId) throw new CryptoError("user id required");
  return enc.encode(`people-os:gcal:${VERSION}:${userId}:${purpose}`);
}

export async function encryptToken(
  secret: string | undefined, userId: string, purpose: TokenPurpose, plaintext: string,
): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(userId, purpose), tagLength: 128 }, key, enc.encode(plaintext),
  );
  return `${VERSION}.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

/** 형식 오류·키 불일치·AAD 불일치(다른 사용자/용도)·변조는 전부 CryptoError. */
export async function decryptToken(
  secret: string | undefined, userId: string, purpose: TokenPurpose, stored: string | null | undefined,
): Promise<string> {
  if (!stored) throw new CryptoError("empty ciphertext");
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new CryptoError("unknown ciphertext format");
  const iv = b64urlDecode(parts[1]);
  const ct = b64urlDecode(parts[2]);
  if (iv.length !== 12 || ct.length < 17) throw new CryptoError("bad ciphertext length");
  const key = await importKey(secret);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad(userId, purpose), tagLength: 128 }, key, ct,
    );
    return dec.decode(pt);
  } catch {
    throw new CryptoError("decrypt failed");
  }
}
