import { describe, it, expect } from "vitest";
import { parseClaudeJson } from "../../src/worker/integrations/anthropic";

interface Sample {
  concepts: Array<{ name: string }>;
}

describe("parseClaudeJson", () => {
  describe("strategy 1: direct parse", () => {
    it("parses well-formed JSON object", () => {
      const result = parseClaudeJson<{ a: number }>(`{"a": 1}`);
      expect(result).toEqual({ a: 1 });
    });

    it("parses well-formed JSON array", () => {
      const result = parseClaudeJson<number[]>(`[1, 2, 3]`);
      expect(result).toEqual([1, 2, 3]);
    });

    it("trims whitespace before parsing", () => {
      const result = parseClaudeJson<{ a: number }>(`  \n  {"a": 1}  \n  `);
      expect(result).toEqual({ a: 1 });
    });
  });

  describe("strategy 2: strip code fences", () => {
    it("strips ```json ... ``` wrapper", () => {
      const text = "```json\n" + JSON.stringify({ concepts: [{ name: "kubernetes" }] }) + "\n```";
      const result = parseClaudeJson<Sample>(text);
      expect(result).toEqual({ concepts: [{ name: "kubernetes" }] });
    });

    it("strips ``` ... ``` wrapper without language tag", () => {
      const text = "```\n" + JSON.stringify({ a: 1 }) + "\n```";
      const result = parseClaudeJson<{ a: number }>(text);
      expect(result).toEqual({ a: 1 });
    });

    it("strips uppercase ```JSON wrapper", () => {
      const text = "```JSON\n" + JSON.stringify({ a: 1 }) + "\n```";
      const result = parseClaudeJson<{ a: number }>(text);
      expect(result).toEqual({ a: 1 });
    });

    it("handles the exact production-error format from the user logs", () => {
      // This is the literal failure case: leading ```json, trailing ```
      const text = `\`\`\`json

  {
    "concepts": [
      {
        "name": "celery",
        "category": "framework",
        "description": "Distributed task queue framework for asynchronous job processing.",
        "aliases": ["celery"]
      }
    ]
  }
  \`\`\``;
      const result = parseClaudeJson<Sample>(text);
      expect(result.concepts[0].name).toBe("celery");
    });

    it("strips fence even if leading whitespace is irregular", () => {
      const text = "   ```json\n{\"a\":1}\n```   ";
      const result = parseClaudeJson<{ a: number }>(text);
      expect(result).toEqual({ a: 1 });
    });

    it("strips a leading fence even when no closing fence exists", () => {
      // Truncated response: the closing ``` is missing.
      const text = '```json\n{"a":1}';
      const result = parseClaudeJson<{ a: number }>(text);
      expect(result).toEqual({ a: 1 });
    });
  });

  describe("strategy 3: outermost JSON slicing", () => {
    it("extracts JSON when prefixed with prose", () => {
      const text = `Here's the JSON output:\n{"a": 1, "b": "hello"}`;
      const result = parseClaudeJson<{ a: number; b: string }>(text);
      expect(result).toEqual({ a: 1, b: "hello" });
    });

    it("extracts JSON with both prefix prose and trailing commentary", () => {
      const text = `Sure! Here's the result:\n{"score": 0.85}\nLet me know if you need adjustments.`;
      const result = parseClaudeJson<{ score: number }>(text);
      expect(result).toEqual({ score: 0.85 });
    });

    it("handles fence + prose combo", () => {
      const text = "Here is the JSON:\n```json\n" + JSON.stringify({ x: 1 }) + "\n```\nLet me know.";
      const result = parseClaudeJson<{ x: number }>(text);
      expect(result).toEqual({ x: 1 });
    });

    it("extracts a JSON array from prose-wrapped output", () => {
      const text = `Result: [1, 2, 3]`;
      const result = parseClaudeJson<number[]>(text);
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe("error handling", () => {
    it("throws on text with no JSON at all", () => {
      expect(() => parseClaudeJson("just some prose")).toThrow();
    });

    it("throws on broken JSON even after fence stripping", () => {
      const text = "```json\n{not valid json\n```";
      expect(() => parseClaudeJson(text)).toThrow();
    });

    it("throws on empty input", () => {
      expect(() => parseClaudeJson("")).toThrow();
    });
  });

  describe("regression: real-world Claude outputs", () => {
    it("parses a multi-concept response with markdown fences", () => {
      // Closely matches the karpenter/celery/terragrunt logs in the bug report.
      const text = `\`\`\`json
{
  "concepts": [
    {
      "name": "karpenter",
      "category": "infrastructure",
      "description": "Kubernetes-native autoscaling solution for AWS EKS",
      "aliases": ["karpenter"]
    },
    {
      "name": "terragrunt",
      "category": "tool",
      "description": "Infrastructure-as-code wrapper for Terraform",
      "aliases": []
    }
  ]
}
\`\`\``;
      const result = parseClaudeJson<Sample>(text);
      expect(result.concepts).toHaveLength(2);
      expect(result.concepts.map((c) => c.name)).toEqual(["karpenter", "terragrunt"]);
    });

    it("parses an empty-concepts response wrapped in fences", () => {
      // The "Batch 3/4 failed" case: response is just an empty list inside fences.
      const text = "```json\n  {\n    \"concepts\": []\n  }\n  ```";
      const result = parseClaudeJson<Sample>(text);
      expect(result.concepts).toEqual([]);
    });

    it("parses an adjacent-scoring response with fences", () => {
      const text = `\`\`\`json
{
  "scores": [
    { "index": 26, "score": 0.65, "concepts": ["machine learning"] },
    { "index": 30, "score": 0.58, "concepts": ["distributed systems"] }
  ]
}
\`\`\``;
      const result = parseClaudeJson<{ scores: Array<{ index: number; score: number }> }>(text);
      expect(result.scores).toHaveLength(2);
      expect(result.scores[0].index).toBe(26);
    });
  });
});
