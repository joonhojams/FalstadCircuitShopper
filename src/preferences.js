// Each user can rank their preferred part types, e.g. "SMD first, then through-hole" or
// "aluminum, then film, then ceramic". The ranking is a first choice plus fallbacks: price
// lookups search the first choice and move down the list only when nothing matches.
// Leaving a type out of a list means "never use it". An empty or missing list means no preference.

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

/** Saved preferences, or null when none (or when the table doesn't exist yet). Never throws. */
export async function loadPreferences(env, userId) {
  try {
    const row = await env.DB.prepare("SELECT preferences FROM user_settings WHERE user_id = ?").bind(userId).first();
    if (!row) return null;
    const checked = validatePreferences(JSON.parse(row.preferences));
    return checked.ok && Object.keys(checked.value).length ? checked.value : null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

export async function savePreferences(env, userId, prefs) {
  if (!Object.keys(prefs).length) {
    await env.DB.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(userId).run();
    return;
  }
  await env.DB
    .prepare(`INSERT INTO user_settings (user_id, preferences, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at`)
    .bind(userId, JSON.stringify(prefs), Date.now()).run();
}
