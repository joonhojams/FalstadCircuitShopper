// Picks the cheapest way to buy N of a part from DigiKey keyword-search results.
// Pure functions, no network. Field names follow DigiKey Product Information V4.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r4 = (n) => Math.round(n * 1e4) / 1e4;

const descText = (p) =>
  typeof p.Description === "string"
    ? p.Description
    : p.Description?.ProductDescription ?? p.Description?.DetailedDescription ?? "";

/** Unit price that applies at `qty`: the largest break not above it (or the first break). */
function priceAt(breaks, qty) {
  let unit = null;
  for (const b of breaks) if (b.q <= qty) unit = b.p;
  return unit ?? breaks[0].p;
}

/**
 * @param {object[]} products  Products[] from a keyword search
 * @param {number} needQty     how many the build needs
 * @param {{inStock?: boolean, max?: number}} opts
 * @returns options sorted cheapest-first, at most one per manufacturer part number
 */
export function cheapestOptions(products, needQty, { inStock = true, max = 3 } = {}) {
  const best = new Map();

  for (const p of products ?? []) {
    if (p.Discontinued || p.EndOfLife) continue;
    const variations = Array.isArray(p.ProductVariations) && p.ProductVariations.length ? p.ProductVariations : [{}];

    for (const v of variations) {
      const breaks = (v.StandardPricing ?? [])
        .map((b) => ({ q: num(b.BreakQuantity), p: num(b.UnitPrice) }))
        .filter((b) => b.q > 0 && b.p > 0)
        .sort((a, b) => a.q - b.q);
      if (!breaks.length && num(p.UnitPrice) > 0) breaks.push({ q: 1, p: p.UnitPrice });
      if (!breaks.length) continue;

      const moq = Math.max(1, num(v.MinimumOrderQuantity) ?? 1);
      const orderQty = Math.max(needQty, moq);
      const stock = num(v.QuantityAvailableforPackageType) ?? num(p.QuantityAvailable) ?? 0;
      if (inStock && stock < orderQty) continue;

      const unitPrice = priceAt(breaks, orderQty);
      const total = r4(unitPrice * orderQty);

      // Sometimes ordering a few more drops into a cheaper price break and costs less overall.
      let buyMore = null;
      for (const b of breaks) {
        if (b.q <= orderQty || (inStock && stock < b.q)) continue;
        const t = r4(b.p * b.q);
        if (t < total && (!buyMore || t < buyMore.total)) buyMore = { quantity: b.q, unitPrice: b.p, total: t };
      }

      const option = {
        mpn: p.ManufacturerProductNumber ?? "",
        dkpn: v.DigiKeyProductNumber ?? "",
        manufacturer: p.Manufacturer?.Name ?? "",
        description: descText(p),
        packaging: v.PackageType?.Name ?? "",
        orderQty,
        unitPrice,
        total,
        stock,
        moq,
        url: p.ProductUrl ?? "",
        datasheet: p.DatasheetUrl ?? "",
        buyMore,
      };
      const key = `${option.manufacturer}|${option.mpn || option.dkpn}`;
      const prev = best.get(key);
      if (!prev || option.total < prev.total) best.set(key, option);
    }
  }

  return [...best.values()].sort((a, b) => a.total - b.total || b.stock - a.stock).slice(0, max);
}
