// Minimal KiCad s-expression reader, used by scripts/gen-footprints.mjs and by the tests to check
// that generated files are well formed. Returns nested arrays; atoms are strings, quoted strings are
// returned without the quotes (and marked in a side set only when asked).

export function parseSexp(text) {
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && /\s/.test(text[i])) i++; };
  function node() {
    ws();
    if (text[i] === "(") {
      i++;
      const list = [];
      for (;;) {
        ws();
        if (i >= n) throw new Error("Unbalanced parentheses: missing )");
        if (text[i] === ")") { i++; return list; }
        list.push(node());
      }
    }
    if (text[i] === '"') {
      let s = "";
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) { s += text[i + 1]; i += 2; } else s += text[i++];
      }
      if (i >= n) throw new Error("Unterminated string");
      i++;
      return s;
    }
    const start = i;
    while (i < n && !/[\s()]/.test(text[i])) i++;
    if (i === start) throw new Error(`Unexpected character "${text[i]}" at ${i}`);
    return text.slice(start, i);
  }
  const out = node();
  ws();
  if (i < n) throw new Error(`Unexpected content after the closing parenthesis at ${i}`);
  return out;
}

/** All direct children of a list that are themselves lists starting with `key`. */
export const kids = (list, key) => list.filter((c) => Array.isArray(c) && c[0] === key);
/** The first such child, or undefined. */
export const kid = (list, key) => kids(list, key)[0];
