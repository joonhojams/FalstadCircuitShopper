// AES-GCM encryption for secrets stored in D1 (each user's DigiKey tokens).
// TOKEN_ENCRYPTION_KEY is base64 of 32 random bytes:  openssl rand -base64 32
// `aad` binds a ciphertext to its owner and purpose, so a copied value won't decrypt elsewhere.

const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();

function rawKey(env) {
  try {
    const raw = fromB64(String(env.TOKEN_ENCRYPTION_KEY ?? ""));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

export const encryptionConfigured = (env) => rawKey(env) !== null;

async function cryptoKey(env) {
  const raw = rawKey(env);
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(env, plaintext, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await cryptoKey(env), enc.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}

export async function decrypt(env, blob, aad) {
  const all = fromB64(blob);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: all.slice(0, 12), additionalData: enc.encode(aad) }, await cryptoKey(env), all.slice(12));
  return new TextDecoder().decode(pt);
}
