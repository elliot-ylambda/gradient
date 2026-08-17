/**
 * A bounded reader for the flat YAML frontmatter that skills and path-scoped
 * rules use.
 *
 * Deliberately not a YAML parser. The fields this code needs — `description`,
 * `when_to_use`, `paths`, and the key list — are flat scalars and simple lists,
 * so a real parser would add a dependency and a parse surface for no gain.
 *
 * It is lenient on purpose. Anything it does not model is skipped, never
 * reported: skills legitimately carry nested maps, and calling one corrupt
 * would report a working skill as broken. `error` is reserved for frontmatter
 * no reader could use, so that "unreadable" can honestly mean "will not load".
 */

const MAX_FRONTMATTER_BYTES = 16_000;
const MAX_KEYS = 64;
const MAX_LIST_ITEMS = 64;
const MAX_SCALAR_CHARS = 8_000;

export type FrontmatterValue = string | string[];

export interface Frontmatter {
  /** Parsed keys in file order. Empty when the document has no frontmatter. */
  values: Record<string, FrontmatterValue>;
  /** Key order as written, for reporting an unknown key at its own position. */
  keys: string[];
  /** True when a `---` block opened and closed. */
  present: boolean;
  /** Set only when the block is unusable to any reader — an unterminated `---`,
   *  or more keys than any real skill has. Content this reader simply does not
   *  model is skipped instead, so `error` can mean "will not load" and be right. */
  error?: string;
  /** Characters consumed by the block, including both delimiters. */
  length: number;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  return value;
}

/** Split an inline `[a, b]` list. Nested brackets are not part of the schema. */
function inlineList(raw: string): string[] | null {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  return body.split(",").map(item => unquote(item)).filter(Boolean).slice(0, MAX_LIST_ITEMS);
}

export function parseFrontmatter(raw: string): Frontmatter {
  const empty: Frontmatter = { values: {}, keys: [], present: false, length: 0 };
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return empty;

  const head = raw.slice(0, MAX_FRONTMATTER_BYTES);
  const close = /\n---[ \t]*(?:\r?\n|$)/.exec(head.slice(3));
  if (!close) {
    return {
      ...empty,
      present: true,
      error: "frontmatter block is never closed",
      length: 0,
    };
  }
  const bodyStart = 3;
  const bodyEnd = bodyStart + close.index + 1;
  const length = bodyEnd + close[0].length - 1;
  const body = head.slice(bodyStart, bodyEnd);

  const values: Record<string, FrontmatterValue> = {};
  const keys: string[] = [];
  let currentKey: string | null = null;

  for (const line of body.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // A `  - item` continuation belongs to the key above it.
    const item = /^[ \t]+-[ \t]+(.*)$/.exec(line);
    if (item && currentKey) {
      const list = Array.isArray(values[currentKey]) ? values[currentKey] as string[] : [];
      if (list.length < MAX_LIST_ITEMS) list.push(unquote(item[1]));
      values[currentKey] = list;
      continue;
    }

    // An indented `key: value` is a nested map — `metadata:` and other
    // free-form maps are legal and both assistants load them. This reader has
    // no use for their contents, but treating them as corruption would report a
    // working skill as broken, which a dogfood run did before this branch
    // existed. Consume and move on.
    if (/^[ \t]+[^\s].*:/.test(line)) continue;

    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    // Anything else — a folded scalar's continuation, an anchor — is outside
    // what this reader models. Skipping is right: `error` is reserved for
    // frontmatter no reader could use, so that it can mean "will not load".
    if (!pair) continue;
    if (keys.length >= MAX_KEYS) {
      return { values, keys, present: true, error: `frontmatter exceeds ${MAX_KEYS} keys`, length };
    }

    const [, key, rest] = pair;
    if (!keys.includes(key)) keys.push(key);
    currentKey = key;
    const list = inlineList(rest);
    if (list) values[key] = list;
    else if (rest.trim() === "") values[key] = [];
    else values[key] = unquote(rest).slice(0, MAX_SCALAR_CHARS);
  }

  return { values, keys, present: true, length };
}

/** Frontmatter scalar, or undefined when the key is absent or holds a list. */
export function scalar(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter.values[key];
  return typeof value === "string" ? value : undefined;
}

/** Frontmatter list, accepting the single-scalar spelling the spec allows for
 *  `paths` (a comma-separated string) as the one-element case. */
export function list(frontmatter: Frontmatter, key: string): string[] {
  const value = frontmatter.values[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map(item => item.trim()).filter(Boolean).slice(0, MAX_LIST_ITEMS);
  }
  return [];
}
