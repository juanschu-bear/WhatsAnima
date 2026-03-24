import { useEffect, useState } from "react";
import type { PerceptionEventMap, PerceptionEventType } from "../types/perception";
import { usePerceptionSession } from "./usePerceptionSession";

export function usePerceptionStream<TType extends PerceptionEventType>(
  sessionId: string | null | undefined,
  type: TType,
) {
  const bus = usePerceptionSession(sessionId);
  const [value, setValue] = useState<PerceptionEventMap[TType] | undefined>(
    () => (bus ? bus.getLatest(type) : undefined),
  );

  useEffect(() => {
    if (!bus) {
      setValue(undefined);
      return;
    }

    setValue(bus.getLatest(type));
    return bus.subscribe(type, (event) => {
      setValue(event.payload);
    });
  }, [bus, type]);

  return value;
}
