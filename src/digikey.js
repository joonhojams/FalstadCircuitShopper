// Minimal DigiKey Product Information V4 client: 2-legged OAuth + keyword search.
// Docs: https://developer.digikey.com/ (token lifetime is 10 minutes).

export class DigiKeyError extends Error {
  constructor(message, status, retryAfter = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const digikeyConfigured = (env) => Boolean(env.DIGIKEY_CLIENT_ID && env.DIGIKEY_CLIENT_SECRET);

// DIGIKEY_API_BASE=https://sandbox-api.digikey.com switches to the sandbox.
export const base = (env) => String(env.DIGIKEY_API_BASE || "https://api.digikey.com").replace(/\/+$/, "");

// Cached per isolate. A cold isolate just fetches a new token.
let cached = { id: "", token: "", exp: 0 };

export async function getToken(env, force = false) {
  if (!force && cached.token && cached.id === env.DIGIKEY_CLIENT_ID && Date.now() < cached.exp) return cached.token;

  const res = await fetch(`${base(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DIGIKEY_CLIENT_ID,
      client_secret: env.DIGIKEY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (res.status === 429) throw new DigiKeyError("DigiKey rate limit reached", 429, Number(res.headers.get("Retry-After")) || null);
  if (!res.ok) throw new DigiKeyError(`DigiKey sign-in failed (${res.status}). Check the client ID and secret.`, 502);

  const data = await res.json();
  if (!data.access_token) throw new DigiKeyError("DigiKey sign-in returned no token.", 502);
  cached = {
    id: env.DIGIKEY_CLIENT_ID,
    token: data.access_token,
    exp: Date.now() + Math.max(0, (Number(data.expires_in) || 600) - 60) * 1000,
  };
  return cached.token;
}

/** POST /products/v4/search/keyword. Returns the matching products (exact matches first). */
export async function searchKeyword(env, keywords, { limit = 30, minQty = 0, inStock = true, marketplace = false } = {}) {
  // Marketplace items are sold by third parties, not DigiKey. Leave the filter out to include them.
  const filters = marketplace ? {} : { MarketPlaceFilter: "ExcludeMarketPlace" };
  if (inStock) {
    filters.SearchOptions = ["InStock"];
    if (minQty > 0) filters.MinimumQuantityAvailable = minQty;
  }
  const body = JSON.stringify({
    Keywords: String(keywords).slice(0, 250),
    Limit: limit,
    Offset: 0,
    FilterOptionsRequest: filters,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(env, attempt > 0);
    const res = await fetch(`${base(env)}/products/v4/search/keyword`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-DIGIKEY-Client-Id": env.DIGIKEY_CLIENT_ID,
        "X-DIGIKEY-Locale-Site": "US",
        "X-DIGIKEY-Locale-Language": "en",
        "X-DIGIKEY-Locale-Currency": "USD",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });
    if (res.status === 401 && attempt === 0) continue; // token revoked or expired early: refresh once
    if (res.status === 429) throw new DigiKeyError("DigiKey rate limit reached", 429, Number(res.headers.get("Retry-After")) || null);
    if (!res.ok) throw new DigiKeyError(`DigiKey search failed (${res.status})`, res.status);

    const data = await res.json();
    const seen = new Set();
    return [...(data.ExactMatches ?? []), ...(data.Products ?? [])].filter((p) => {
      const k = p.ManufacturerProductNumber ?? JSON.stringify(p.ProductVariations?.[0]?.DigiKeyProductNumber ?? p);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  throw new DigiKeyError("DigiKey rejected the access token.", 502);
}
