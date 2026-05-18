import { describe, expect, it } from "vitest";
import { stripCiteTags, stripCiteTagsFromText } from "../../src/worker/services/content-cleanup.js";

/**
 * Anthropic's web_search-equipped writers like to wrap cited spans in
 * `<cite index="1-1">...</cite>` tags inline. The post-process strip
 * is what keeps that markup out of the persisted prose; if a future
 * refactor accidentally bypasses it (or the regex stops matching the
 * model's actual output shape), the strings below catch it.
 */
describe("stripCiteTagsFromText", () => {
  it("strips a simple single-citation tag", () => {
    expect(stripCiteTagsFromText('Hello <cite index="1-1">world</cite>.')).toBe("Hello world.");
  });

  it("strips multi-index citations", () => {
    expect(stripCiteTagsFromText('A <cite index="1-12,1-13,1-14">claim</cite> here.')).toBe("A claim here.");
  });

  it("strips multiple separate citation tags in one string", () => {
    expect(stripCiteTagsFromText('<cite index="1-1">First</cite> and <cite index="2-1">second</cite>.')).toBe(
      "First and second.",
    );
  });

  it("strips citations that span newlines", () => {
    expect(stripCiteTagsFromText('<cite index="1-1">line one\nline two</cite>')).toBe("line one\nline two");
  });

  it("strips orphan opening tags (truncated output)", () => {
    expect(stripCiteTagsFromText('Hello <cite index="1-1">world.')).toBe("Hello world.");
  });

  it("strips orphan closing tags (truncated output)", () => {
    expect(stripCiteTagsFromText("Hello world</cite>.")).toBe("Hello world.");
  });

  it("passes clean prose through unchanged (referential equality)", () => {
    const v = "Plain prose with no cite tags.";
    expect(stripCiteTagsFromText(v)).toBe(v);
  });

  it("is case-insensitive on the tag name", () => {
    expect(stripCiteTagsFromText('<CITE index="1-1">x</CITE>')).toBe("x");
  });
});

describe("stripCiteTags (block list)", () => {
  it("strips tags from text and heading blocks only — code/diagram are left alone", () => {
    const input = [
      { type: "text" as const, value: 'Hi <cite index="1-1">world</cite>.' },
      { type: "heading" as const, value: '<cite index="2-1">Section</cite>' },
      // Code blocks shouldn't be touched — the writer should never have
      // emitted cite tags in code, but if they did the surrounding `<>`
      // is more likely to be the source than a citation marker.
      { type: "code" as const, value: '<cite index="x">not a real cite tag</cite>', language: "html" },
      { type: "diagram" as const, value: "graph TD; A-->B" },
    ];
    const out = stripCiteTags(input);
    expect(out[0].value).toBe("Hi world.");
    expect(out[1].value).toBe("Section");
    expect(out[2].value).toBe('<cite index="x">not a real cite tag</cite>');
    expect(out[3].value).toBe("graph TD; A-->B");
  });

  it("preserves block identity for unchanged blocks", () => {
    const clean = { type: "text" as const, value: "plain prose" };
    const input = [clean];
    const out = stripCiteTags(input);
    expect(out[0]).toBe(clean);
  });
});
