import { usePerceptionStream } from "./usePerceptionStream";

export function useLucidStream(sessionId: string | null | undefined) {
  return usePerceptionStream(sessionId, "lucid");
}
