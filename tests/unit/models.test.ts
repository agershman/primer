import { describe, it, expect } from "vitest";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODELS,
  resolveModel,
  isValidModel,
  modelLabel,
} from "../../src/worker/config/models";

describe("models registry", () => {
  it("exposes three tiers: fast, balanced, quality", () => {
    const tiers = AVAILABLE_MODELS.map((m) => m.tier);
    expect(tiers).toContain("fast");
    expect(tiers).toContain("balanced");
    expect(tiers).toContain("quality");
  });

  it("every available model has id, label, tier, description", () => {
    for (const m of AVAILABLE_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.tier).toBeTruthy();
      expect(m.description).toBeTruthy();
    }
  });

  it("DEFAULT_MODELS defines every operation", () => {
    const operations = [
      "conceptExtraction",
      "adjacentScoring",
      "teachingPiece",
      "deepDive",
      "quizGeneration",
      "quizAssessment",
      "chat",
    ] as const;
    for (const op of operations) {
      expect(DEFAULT_MODELS[op]).toBeTruthy();
      expect(isValidModel(DEFAULT_MODELS[op])).toBe(true);
    }
  });

  it("DEFAULT_MODELS uses Haiku for structured/fast operations", () => {
    expect(DEFAULT_MODELS.conceptExtraction).toContain("haiku");
    expect(DEFAULT_MODELS.adjacentScoring).toContain("haiku");
    expect(DEFAULT_MODELS.quizGeneration).toContain("haiku");
  });

  it("DEFAULT_MODELS uses Sonnet for quality-sensitive operations", () => {
    expect(DEFAULT_MODELS.teachingPiece).toContain("sonnet");
    expect(DEFAULT_MODELS.deepDive).toContain("sonnet");
    expect(DEFAULT_MODELS.quizAssessment).toContain("sonnet");
    expect(DEFAULT_MODELS.chat).toContain("sonnet");
  });
});

describe("resolveModel", () => {
  it("returns a ModelSpec for the configured model if valid", () => {
    const settings = {
      models: { teachingPiece: "claude-opus-4-20250514" },
    };
    const spec = resolveModel(settings, "teachingPiece");
    expect(spec.model).toBe("claude-opus-4-20250514");
    expect(spec.provider).toBe("anthropic");
  });

  it("falls back to default if no override", () => {
    expect(resolveModel({}, "teachingPiece").model).toBe(DEFAULT_MODELS.teachingPiece);
  });

  it("falls back to default if settings is null", () => {
    expect(resolveModel(null, "chat").model).toBe(DEFAULT_MODELS.chat);
  });

  it("falls back to default if settings is undefined", () => {
    expect(resolveModel(undefined, "conceptExtraction").model).toBe(DEFAULT_MODELS.conceptExtraction);
  });

  it("falls back to default if configured model is invalid", () => {
    const settings = { models: { teachingPiece: "fake-model-id" } };
    expect(resolveModel(settings, "teachingPiece").model).toBe(DEFAULT_MODELS.teachingPiece);
  });

  it("each operation resolves independently", () => {
    const settings = {
      models: {
        teachingPiece: "claude-opus-4-20250514",
        chat: "claude-haiku-4-5-20251001",
      },
    };
    expect(resolveModel(settings, "teachingPiece").model).toBe("claude-opus-4-20250514");
    expect(resolveModel(settings, "chat").model).toBe("claude-haiku-4-5-20251001");
    expect(resolveModel(settings, "quizAssessment").model).toBe(DEFAULT_MODELS.quizAssessment);
  });

  it("structured spec overrides round-trip cleanly through catalog validation", () => {
    const settings = {
      models: {
        teachingPiece: { provider: "anthropic", model: "claude-opus-4-20250514" },
      },
    };
    const spec = resolveModel(settings, "teachingPiece");
    expect(spec.provider).toBe("anthropic");
    expect(spec.model).toBe("claude-opus-4-20250514");
  });

  it("structured spec referring to a non-catalog model falls back to default", () => {
    const settings = {
      models: {
        teachingPiece: { provider: "anthropic", model: "claude-not-a-real-model" },
      },
    };
    expect(resolveModel(settings, "teachingPiece").model).toBe(DEFAULT_MODELS.teachingPiece);
  });
});

describe("modelLabel", () => {
  it("returns pretty label for known models", () => {
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(modelLabel("claude-sonnet-4-20250514")).toBe("Claude Sonnet 4");
    expect(modelLabel("claude-opus-4-20250514")).toBe("Claude Opus 4");
  });

  it("falls back to raw id for unknown models", () => {
    expect(modelLabel("unknown-model")).toBe("unknown-model");
  });

  it("returns generic 'Claude' for null/undefined", () => {
    expect(modelLabel(null)).toBe("Claude");
    expect(modelLabel(undefined)).toBe("Claude");
  });
});

describe("isValidModel", () => {
  it("returns true for registered model ids", () => {
    for (const m of AVAILABLE_MODELS) {
      expect(isValidModel(m.id)).toBe(true);
    }
  });

  it("returns false for unregistered model ids", () => {
    expect(isValidModel("fake-model")).toBe(false);
    expect(isValidModel("")).toBe(false);
  });
});
