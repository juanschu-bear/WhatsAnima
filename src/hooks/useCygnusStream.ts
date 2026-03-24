import { usePerceptionStream } from "./usePerceptionStream";

export function useCygnusStream(sessionId: string | null | undefined) {
  return usePerceptionStream(sessionId, "cygnus");
}
