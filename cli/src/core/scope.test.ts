import { describe, it, expect } from "vitest";
import { resolveScanScope, DEFAULT_USER_SCOPE_DAYS } from "./scope.js";

describe("resolveScanScope", () => {
  it("defaults to project scope with no window", () => {
    const r = resolveScanScope({});
    expect(r).toMatchObject({ scope: "project", sinceDays: undefined });
    expect(r.label).toContain("project scope");
  });

  it("project scope honors an explicit --since", () => {
    expect(resolveScanScope({ since: 14 })).toMatchObject({ scope: "project", sinceDays: 14 });
  });

  it("--user is cross-project, bounded to the default window", () => {
    const r = resolveScanScope({ user: true });
    expect(r.scope).toBe("all");
    expect(r.sinceDays).toBe(DEFAULT_USER_SCOPE_DAYS);
    expect(r.label).toContain("user scope");
  });

  it("--user honors an explicit --since override", () => {
    expect(resolveScanScope({ user: true, since: 30 })).toMatchObject({ scope: "all", sinceDays: 30 });
  });

  it("--user window is configurable", () => {
    expect(resolveScanScope({ user: true }, { userScopeDays: 3 }).sinceDays).toBe(3);
  });

  it("--all is cross-project with no time bound", () => {
    expect(resolveScanScope({ all: true })).toMatchObject({ scope: "all", sinceDays: undefined });
  });

  it("--all takes precedence over --user", () => {
    expect(resolveScanScope({ all: true, user: true }).sinceDays).toBeUndefined();
  });
});
