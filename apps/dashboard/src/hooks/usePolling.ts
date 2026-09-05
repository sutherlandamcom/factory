import { useEffect } from "react";

/** Re-runs the callback every `ms` while the component is mounted. */
export function usePolling(cb: () => void, ms = 5000) {
  useEffect(() => {
    const id = setInterval(cb, ms);
    return () => clearInterval(id);
  }, [cb, ms]);
}
