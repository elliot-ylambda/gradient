// Deterministic minhash + LSH banding. Pure and dependency-free so clustering
// scales near-linearly instead of comparing every candidate pair. No RNG — hash
// coefficients are derived from the index so signatures are stable across runs.

export const LSH_NUM_HASHES = 120;
export const LSH_BANDS = 20;
export const LSH_ROWS = 6; // LSH_BANDS * LSH_ROWS === LSH_NUM_HASHES

// FNV-1a 32-bit string hash.
function h32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Universal-hash coefficients, deterministic per hash index.
function coeffs(n: number): { a: number[]; b: number[] } {
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < n; i++) {
    a.push((Math.imul(i, 2) + 1) >>> 0 | 1);              // odd multiplier
    b.push((Math.imul(i, 0x85ebca77) + 0x165667b1) >>> 0);
  }
  return { a, b };
}

export function minhash(shingles: Set<string>, numHashes = LSH_NUM_HASHES): number[] {
  const { a, b } = coeffs(numHashes);
  const out = new Array<number>(numHashes).fill(0xffffffff);
  for (const sh of shingles) {
    const x = h32(sh);
    for (let i = 0; i < numHashes; i++) {
      const v = (Math.imul(a[i], x) + b[i]) >>> 0;
      if (v < out[i]) out[i] = v;
    }
  }
  return out;
}

export function bandKeys(
  signature: number[],
  opts: { bands?: number; rows?: number } = {},
): string[] {
  const bands = opts.bands ?? LSH_BANDS;
  const rows = opts.rows ?? LSH_ROWS;
  const keys: string[] = [];
  for (let band = 0; band < bands; band++) {
    const start = band * rows;
    keys.push(`${band}:${signature.slice(start, start + rows).join(",")}`);
  }
  return keys;
}
