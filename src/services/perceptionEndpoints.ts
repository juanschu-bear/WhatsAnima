import type {
  CaptureFrame,
  CygnusOutput,
  DeliveryPacket,
  LucidOutput,
  OracleOutput,
  TranscriptChunk,
  TraceEvent,
  TransportState,
} from "../types/perception";

export type RealtimeTransportKind = "http" | "sse" | "websocket" | "webrtc";

export type EndpointStatus = "idle" | "connecting" | "live" | "error";

export type PerceptionEndpointConfig = {
  id: string;
  label: string;
  transport: RealtimeTransportKind;
  path: string;
};

export type PerceptionEndpointMap = {
  capture: PerceptionEndpointConfig;
  transcript: PerceptionEndpointConfig;
  cygnus: PerceptionEndpointConfig;
  oracle: PerceptionEndpointConfig;
  lucid: PerceptionEndpointConfig;
  delivery: PerceptionEndpointConfig;
  trace: PerceptionEndpointConfig;
  transport: PerceptionEndpointConfig;
};

export type PerceptionConnectorState = {
  endpoint: PerceptionEndpointConfig;
  status: EndpointStatus;
  lastMessageAt?: number;
  lastError?: string;
};

export type PerceptionEndpointPayloadMap = {
  capture: CaptureFrame;
  transcript: TranscriptChunk;
  cygnus: CygnusOutput;
  oracle: OracleOutput;
  lucid: LucidOutput;
  delivery: DeliveryPacket;
  trace: TraceEvent;
  transport: TransportState;
};

export function createDefaultPerceptionEndpoints(
  apiBase = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, ""),
): PerceptionEndpointMap {
  return {
    capture: {
      id: "capture",
      label: "Capture ingest",
      transport: "webrtc",
      path: `${apiBase}/realtime/capture`,
    },
    transcript: {
      id: "transcript",
      label: "Transcript stream",
      transport: "sse",
      path: `${apiBase}/realtime/transcript`,
    },
    cygnus: {
      id: "cygnus",
      label: "Cygnus Lite stream",
      transport: "sse",
      path: `${apiBase}/realtime/cygnus`,
    },
    oracle: {
      id: "oracle",
      label: "Oracle RT stream",
      transport: "sse",
      path: `${apiBase}/realtime/oracle`,
    },
    lucid: {
      id: "lucid",
      label: "Lucid stream",
      transport: "sse",
      path: `${apiBase}/realtime/lucid`,
    },
    delivery: {
      id: "delivery",
      label: "Delivery relay",
      transport: "websocket",
      path: `${apiBase}/realtime/delivery`,
    },
    trace: {
      id: "trace",
      label: "System trace",
      transport: "sse",
      path: `${apiBase}/realtime/trace`,
    },
    transport: {
      id: "transport",
      label: "Transport state",
      transport: "sse",
      path: `${apiBase}/realtime/transport`,
    },
  };
}
