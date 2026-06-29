// Zero-dependency terminal styling. Truecolor where supported, plain otherwise.

const COLOR =
  !!process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

function wrap(open: string, s: string): string {
  return COLOR ? `\x1b[${open}m${s}\x1b[0m` : s;
}
function rgb(r: number, g: number, b: number, s: string): string {
  return COLOR ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s;
}

// Brand stops: violet (high confidence) -> orchid -> coral (flagged).
const G1 = [124, 108, 255] as const;
const G3 = [255, 126, 107] as const;

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Paint a string across the brand gradient, character by character. */
export function gradientText(s: string): string {
  if (!COLOR) return s;
  const chars = [...s];
  const n = Math.max(chars.length - 1, 1);
  return chars
    .map((ch, i) => {
      const t = i / n;
      return rgb(lerp(G1[0], G3[0], t), lerp(G1[1], G3[1], t), lerp(G1[2], G3[2], t), ch);
    })
    .join("");
}

export const c = {
  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  violet: (s: string) => rgb(157, 144, 255, s),
  orchid: (s: string) => rgb(217, 139, 214, s),
  coral: (s: string) => rgb(255, 156, 140, s),
  blue: (s: string) => rgb(135, 183, 255, s),
  ok: (s: string) => rgb(157, 144, 255, s),
  muted: (s: string) => rgb(139, 145, 164, s),
};

/** Confidence/kind chip mirroring the website's colored [labels]. Fixed width. */
export function chip(label: "high" | "inferred" | "hook" | "loop"): string {
  // 4-char codes so every chip renders as a uniform 6-char "[code]".
  const text = `[${label === "inferred" ? "infr" : label}]`;
  switch (label) {
    case "high":
      return c.violet(text);
    case "inferred":
      return c.orchid(text);
    case "hook":
      return c.blue(text);
    case "loop":
      return c.coral(text);
  }
}

export function banner(version: string): string {
  return `${gradientText("gradient")} ${c.dim(`· analysis engine v${version}`)}`;
}
