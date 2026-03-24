import { useMemo } from "react";
import { getPerceptionSessionBus } from "../lib/sessionBus";

export function usePerceptionSession(sessionId: string | null | undefined) {
  return useMemo(
    () => (sessionId ? getPerceptionSessionBus(sessionId) : null),
    [sessionId],
  );
}
