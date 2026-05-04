import { useCallback, useEffect, useState } from "react";

export type FontSize = "small" | "medium" | "large";

const STORAGE_KEY = "primer-font-size";

const SIZE_MAP: Record<FontSize, string> = {
  small: "14px",
  medium: "16px",
  large: "18px",
};

function applyFontSize(size: FontSize) {
  document.documentElement.style.fontSize = SIZE_MAP[size];
  document.documentElement.dataset.fontSize = size;
}

export function useFontSize() {
  const [size, setSizeState] = useState<FontSize>(() => {
    if (typeof window === "undefined") return "medium";
    return (localStorage.getItem(STORAGE_KEY) as FontSize) || "medium";
  });

  const setSize = useCallback((newSize: FontSize) => {
    setSizeState(newSize);
    localStorage.setItem(STORAGE_KEY, newSize);
    applyFontSize(newSize);
  }, []);

  useEffect(() => {
    applyFontSize(size);
  }, [size]);

  return { size, setSize };
}
