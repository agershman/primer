/**
 * Pins the de-duplication + race-cancellation contract on
 * `useConcepts`.
 *
 * The user reported seeing the same concept ("environment metadata
 * discovery") rendered twice in the Platform trail. The DB only had
 * one row for that concept (`UNIQUE(user_id, canonical_name)` is in
 * place), but two fetch flows raced into the same `concepts` array:
 *
 *   - The initial paginated mount fired `fetchConcepts(true)` with
 *     PAGE_SIZE=20.
 *   - The IntersectionObserver sentinel saw `hasMore=true` and
 *     fired `loadMore()` with offset=20 (next page).
 *   - The trails view's effect saw `total > concepts.length` and
 *     fired `loadAll()` (limit=500, offset=0).
 *
 * If `loadAll` resolved first and the still-in-flight `loadMore`
 * resolved after, `loadMore`'s setConcepts callback APPENDED its
 * offset-20 page on top of the already-complete list — duplicating
 * the last 10 items.
 *
 * Two-layer fix:
 *
 *   1. A monotonic `fetchTokenRef` bumped on every reset
 *      (fetchConcepts(true), loadAll, sort/filter changes). Each
 *      fetch reads the token at start and drops its response if the
 *      token moved on. Closes the race the proper way.
 *
 *   2. `dedupeById` applied at every setConcepts site as a cheap
 *      belt-and-suspenders — protects rendering even if a token
 *      check misses (e.g. fetch token bumped after the fetch
 *      started but before its setConcepts ran).
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("useConcepts: dedupeById", () => {
  it("declares a dedupeById helper used at every setConcepts site", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    expect(src).toMatch(/function dedupeById\(items: ConceptData\[\]\): ConceptData\[\]/);
    // Used in: fetchConcepts(reset=true), fetchConcepts(reset=false),
    // and loadAll. Three call sites.
    const calls = src.match(/dedupeById\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4); // 1 declaration + 3 call sites
  });

  it("dedupes by id, not by canonical_name", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    // The dedup key is the server-generated cpt_* id — id-keyed
    // dedup is the safe choice because two concepts CAN legitimately
    // share a normalized prefix in the future. Pin this so a
    // future refactor doesn't accidentally swap to canonical_name.
    expect(src).toMatch(/seen\.has\(item\.id\)/);
    expect(src).not.toMatch(/seen\.has\(item\.canonical_name\)/);
  });
});

describe("useConcepts: fetchTokenRef invalidates stale responses", () => {
  it("bumps the token on every reset (fetchConcepts(true), loadAll)", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    expect(src).toMatch(/const fetchTokenRef = useRef\(0\)/);
    // Two `fetchTokenRef.current += 1` sites — one in
    // fetchConcepts(reset=true), one in loadAll. loadMore does NOT
    // bump the token (it appends to the existing list).
    const bumps = src.match(/fetchTokenRef\.current \+= 1/g) ?? [];
    expect(bumps.length).toBe(2);
  });

  it("captures the token at fetch start and re-checks before mutating state", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    // Both fetchConcepts and loadAll grab `myToken = fetchTokenRef.current`
    // at the start, then `if (myToken !== fetchTokenRef.current) return`
    // before each setState. Ensures the stale fetch can't leak its
    // response into shared state.
    expect(src).toMatch(/const myToken = fetchTokenRef\.current/);
    const guards = src.match(/if \(myToken !== fetchTokenRef\.current\) return/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it("loadMore does NOT bump the token (preserves append semantics)", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    // The reset branch alone bumps the token. The non-reset path
    // (loadMore) is supposed to append onto existing state, so it
    // must not invalidate itself.
    expect(src).toMatch(
      /if \(reset\) \{[\s\S]{0,500}fetchTokenRef\.current \+= 1/,
    );
    // Sanity: there's no token bump on the non-reset arm.
    expect(src).not.toMatch(/setLoadingMore\(true\);[\s\S]{0,200}fetchTokenRef\.current \+= 1/);
  });
});

describe("useConcepts: setConcepts callbacks always run dedupeById", () => {
  it("the loadMore append path wraps the spread with dedupeById", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    expect(src).toMatch(
      /setConcepts\(\(prev\) => dedupeById\(\[\.\.\.prev, \.\.\.data\.concepts\]\)\)/,
    );
  });

  it("the reset path wraps the new array with dedupeById", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    expect(src).toMatch(/setConcepts\(dedupeById\(data\.concepts\)\)/);
  });
});
