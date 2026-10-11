"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "sys";
const STORAGE_KEY = "samograph-theme";
const THEMES: Theme[] = ["light", "dark", "sys"];

function applyTheme(theme: Theme): void {
  if (theme === "sys") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Web Storage can throw (for example, in Safari private mode). The DOM
    // theme above must still apply even when the preference cannot persist.
  }
}

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>("sys");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "sys") setTheme(stored);
    } catch {
      // Keep the system default when Web Storage is unavailable.
    }
  }, []);

  return (
    <div className="samograph-theme-switcher" role="group" aria-label="Theme">
      {THEMES.map((option) => (
        <button
          className="samograph-theme-switcher__option"
          type="button"
          aria-pressed={theme === option}
          key={option}
          onClick={() => {
            setTheme(option);
            applyTheme(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
