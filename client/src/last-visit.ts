import { useState } from "react";

const KEY = "auto-dev.lastVisit";

// The previous visit is whatever this browser stored last time; this visit is recorded right away,
// so the next page load starts a new digest. Null on the very first visit.
export function useLastVisit(nowIso: () => string = () => new Date().toISOString()): string | null {
  const [since] = useState<string | null>(() => {
    let previous: string | null = null;
    try {
      previous = localStorage.getItem(KEY);
      localStorage.setItem(KEY, nowIso());
    } catch {
      // Private mode or blocked storage: no digest, nothing else changes.
    }
    return previous;
  });
  return since;
}
