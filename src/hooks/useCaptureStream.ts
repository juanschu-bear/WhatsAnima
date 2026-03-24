import { usePerceptionStream } from "./usePerceptionStream";

export function useCaptureStream(sessionId: string | null | undefined) {
  return usePerceptionStream(sessionId, "capture");
}
