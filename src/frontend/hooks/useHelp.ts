import { useNavigate } from "react-router-dom";

const SECTION_TO_PATH: Record<string, string> = {
  welcome: "getting-started/welcome",
  setup: "getting-started/setup",
  "first-briefing": "getting-started/your-first-briefing",
  "briefing-generation": "briefings/how-generation-works",
  "teaching-pieces": "briefings/teaching-pieces",
  feedback: "briefings/feedback",
  "deep-dives": "briefings/deep-dives",
  "near-misses": "briefings/near-misses",
  "work-context": "briefings/work-context",
  "depth-scale": "concepts/depth-scale",
  "concept-graph": "concepts/concept-graph",
  confidence: "concepts/confidence",
  decay: "concepts/decay",
  sparklines: "concepts/sparklines",
  relations: "concepts/relations",
  quizzes: "calibration/quizzes",
  assessment: "calibration/assessment",
  baseline: "calibration/baseline",
  shortcuts: "reference/keyboard-shortcuts",
  configuration: "reference/configuration",
  "ai-models": "reference/ai-models",
  models: "reference/ai-models",
  analytics: "reference/analytics",
  bookmarks: "reference/api-endpoints",
  api: "reference/api-endpoints",
  chat: "briefings/chat",
  troubleshooting: "troubleshooting/common-issues",
};

export function useHelp() {
  const navigate = useNavigate();

  function openHelp(section?: string) {
    if (!section) {
      navigate("/help");
      return;
    }

    const path = SECTION_TO_PATH[section];
    if (path) {
      navigate(`/help/${path}`);
    } else if (section.includes("/")) {
      navigate(`/help/${section}`);
    } else {
      navigate("/help");
    }
  }

  return { openHelp };
}
