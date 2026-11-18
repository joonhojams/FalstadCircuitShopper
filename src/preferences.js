// Each user can rank their preferred part types, e.g. "SMD first, then through-hole" or
// "aluminum, then film, then ceramic". The ranking is a first choice plus fallbacks: price
// lookups search the first choice and move down the list only when nothing matches.
// Leaving a type out of a list means "never use it". An empty or missing list means no preference.
//
// The same stored JSON also holds the pricing filters (in stock only, include tariffed, ...)
// under a "filters" key. They are validated separately, so saving one never touches the other.

import { TIERS } from "./brands.js";

export const CATALOG = {
  mounting: {
    title: "Mounting style",
    help: "How parts attach to the board. Used for every part that comes in both styles.",
    items: [
      { id: "smd", label: "Surface mount (SMD)" },
      { id: "tht", label: "Through-hole" },
    ],
  },
  capacitor: {
    title: "Capacitor type",
    help: "Applies to capacitors. If a type has no stock at the value you need, the next one is tried.",
    items: [
      { id: "ceramic", label: "Ceramic" },
      { id: "film", label: "Film" },
      { id: "aluminum", label: "Aluminum electrolytic" },
      { id: "tantalum", label: "Tantalum" },
    ],
  },
  resistor: {
    title: "Resistor type",
    help: "Applies to resistors. If a type has no stock at the value you need, the next one is tried.",
    items: [
      { id: "metal_film", label: "Metal film" },
      { id: "carbon_film", label: "Carbon film" },
      { id: "thick_film", label: "Thick film (chip)" },
    ],
  },
  brand: {
    title: "Brand reputation",
    help: "Prefer makers by general reputation instead of picking brands one by one. The cheapest option from your top-ranked group is chosen, and the next group is used only if the first has nothing in stock. Groups are a rough rule of thumb, not a guarantee.",
    items: [
      ...Object.entries(TIERS).map(([id, t]) => ({ id, label: `${t.label} (${t.examples})` })),
      { id: "unrated", label: "Unrated (any maker not in the lists above)" },
    ],
  },
};

const MAX_BYTES = 2000;

/** @returns {{ok: true, value: object} | {ok: false, error: string}} */
export function validatePreferences(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Preferences must be an object." };
  const value = {};
  for (const [cat, list] of Object.entries(input)) {
    const spec = CATALOG[cat];
    if (!spec) return { ok: false, error: `Unknown preference "${String(cat).slice(0, 40)}".` };
    if (!Array.isArray(list)) return { ok: false, error: `"${cat}" must be a list.` };
    const ids = new Set(spec.items.map((i) => i.id));
    const seen = new Set();
    for (const id of list) {
      if (typeof id !== "string" || !ids.has(id)) return { ok: false, error: `Unknown ${cat} type "${String(id).slice(0, 40)}".` };
      if (seen.has(id)) return { ok: false, error: `"${id}" is listed twice.` };
      seen.add(id);
    }
    if (list.length) value[cat] = [...list];
  }
  if (JSON.stringify(value).length > MAX_BYTES) return { ok: false, error: "Preferences are too large." };
  return { ok: true, value };
}

const FILTER_FLAGS = ["inStock", "normallyStocking", "tariffed", "marketplace"];
const FILTER_PACKAGES = ["pref", "tht", "smd", "any"];

/** Pricing filters: any of the four true/false flags and the parts package. Missing keys mean "not set". */
export function validateFilters(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Filters must be an object." };
  const value = {};
  for (const [key, v] of Object.entries(input)) {
    if (FILTER_FLAGS.includes(key)) {
      if (typeof v !== "boolean") return { ok: false, error: `"${key}" must be true or false.` };
    } else if (key === "package") {
      if (!FILTER_PACKAGES.includes(v)) return { ok: false, error: "Unknown parts package." };
    } else {
      return { ok: false, error: `Unknown filter "${String(key).slice(0, 40)}".` };
    }
    value[key] = v;
  }
  return { ok: true, value };
}

// Reads the stored row. Throws on database errors (so a failed read never leads to an overwrite);
// a missing row or unreadable JSON counts as "nothing saved".
async function readStored(env, userId) {
  const row = await env.DB.prepare("SELECT preferences FROM user_settings WHERE user_id = ?").bind(userId).first();
  let raw = {};
  try { raw = row ? JSON.parse(row.preferences) : {}; } catch { /* treat as empty */ }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const { filters, ...rankings } = raw;
  const r = validatePreferences(rankings);
  const f = filters === undefined ? null : validateFilters(filters);
  return { preferences: r.ok ? r.value : {}, filters: f && f.ok ? f.value : {} };
}

async function writeStored(env, userId, preferences, filters) {
  const value = { ...preferences };
  if (Object.keys(filters).length) value.filters = filters;
  if (!Object.keys(value).length) {
    await env.DB.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(userId).run();
    return;
  }
  await env.DB
    .prepare(`INSERT INTO user_settings (user_id, preferences, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at`)
    .bind(userId, JSON.stringify(value), Date.now()).run();
}

/** { preferences, filters }, each an object or null when nothing is saved (or the table doesn't exist yet). Never throws. */
export async function loadStored(env, userId) {
  try {
    const s = await readStored(env, userId);
    return {
      preferences: Object.keys(s.preferences).length ? s.preferences : null,
      filters: Object.keys(s.filters).length ? s.filters : null,
    };
  } catch (e) {
    console.error(e);
    return { preferences: null, filters: null };
  }
}

/** Saved part-type rankings, or null when none. Never throws. */
export async function loadPreferences(env, userId) {
  return (await loadStored(env, userId)).preferences;
}

/** Replaces the part-type rankings and keeps any saved filters. */
export async function savePreferences(env, userId, prefs) {
  const cur = await readStored(env, userId);
  await writeStored(env, userId, prefs, cur.filters);
}

/** Merges the given filters over the saved ones and keeps the part-type rankings. */
export async function saveFilters(env, userId, filters) {
  const cur = await readStored(env, userId);
  await writeStored(env, userId, cur.preferences, { ...cur.filters, ...filters });
}
