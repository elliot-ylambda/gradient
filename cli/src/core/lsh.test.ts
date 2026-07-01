import { describe, it, expect } from "vitest";
import { minhash, bandKeys, LSH_NUM_HASHES, LSH_BANDS } from "./lsh.js";

const shingle = (s: string) => new Set(s.split(""));

describe("minhash", () => {
  it("produces a signature of numHashes length", () => {
    expect(minhash(shingle("abcdef")).length).toBe(LSH_NUM_HASHES);
  });
  it("is identical for identical sets and stable across calls", () => {
    expect(minhash(shingle("abcdef"))).toEqual(minhash(shingle("abcdef")));
  });
});

describe("bandKeys", () => {
  it("produces one key per band", () => {
    expect(bandKeys(minhash(shingle("abcdef"))).length).toBe(LSH_BANDS);
  });
  it("identical sets share all band keys; disjoint sets share none", () => {
    const a = bandKeys(minhash(shingle("the quick brown fox")));
    const b = bandKeys(minhash(shingle("the quick brown fox")));
    const c = bandKeys(minhash(shingle("ZZZZZZ 9999 %%%")));
    expect(a).toEqual(b);
    expect(a.some(k => c.includes(k))).toBe(false);
  });
});
