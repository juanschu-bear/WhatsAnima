import { usePerceptionStream } from "./usePerceptionStream";

export function useOracleStream(sessionId: string | null | undefined) {
  return usePerceptionStream(sessionId, "oracle");
}
