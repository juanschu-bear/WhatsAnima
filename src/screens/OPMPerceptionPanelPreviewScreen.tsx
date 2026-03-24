import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Rnd, type RndDragCallback, type RndResizeCallback } from "react-rnd";
import { useCygnusStream } from "../hooks/useCygnusStream";
import { useLucidStream } from "../hooks/useLucidStream";
import { useOracleStream } from "../hooks/useOracleStream";
import { usePerceptionSession } from "../hooks/usePerceptionSession";
import { usePerceptionStream } from "../hooks/usePerceptionStream";
import { createCaptureAdapter, type MotionTrack } from "../services/captureAdapter";
import {
  buildPreviewState,
  createPreviewAnalysisAdapter,
  PREVIEW_ALL_ACTION_UNITS,
  toneLabel,
} from "../services/previewAnalysisAdapter";

type WindowId = "stage" | "cygnus" | "oracle" | "lucid" | "patterns" | "trace";

type WindowLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
};

type Pattern = {
  name: string;
  modality: "cross_modal" | "face_au" | "vocal" | "semantic" | "body";
  confidence: number;
  status: "aligned" | "watch" | "divergent";
};

const INITIAL_WINDOWS: Record<WindowId, WindowLayout> = {
  stage: { x: 28, y: 28, width: 1080, height: 760, z: 2 },
  cygnus: { x: 1140, y: 28, width: 740, height: 520, z: 3 },
  oracle: { x: 1140, y: 570, width: 740, height: 400, z: 4 },
  lucid: { x: 1140, y: 990, width: 740, height: 360, z: 5 },
  patterns: { x: 28, y: 820, width: 660, height: 230, z: 3 },
  trace: { x: 710, y: 820, width: 400, height: 530, z: 4 },
};

const MIN_BOARD_WIDTH = 2600;
const MIN_BOARD_HEIGHT = 1900;
const LAYOUT_STORAGE_KEY = "opm-workspace-layout-v1";
const PREVIEW_FALLBACK_SESSION_ID = "opm-preview-live";
const PREVIEW_PARTICIPANT_ID = "local-operator";

const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);

function isWindowLayout(value: unknown): value is WindowLayout {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return ["x", "y", "width", "height", "z"].every(
    (key) => typeof candidate[key] === "number",
  );
}

function readSavedLayouts() {
  if (typeof window === "undefined") {
    return INITIAL_WINDOWS;
  }

  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return INITIAL_WINDOWS;
    }

    const parsed = JSON.parse(raw) as Partial<Record<WindowId, unknown>>;
    const nextLayouts = { ...INITIAL_WINDOWS };

    for (const windowId of Object.keys(INITIAL_WINDOWS) as WindowId[]) {
      const candidate = parsed[windowId];
      if (isWindowLayout(candidate)) {
        nextLayouts[windowId] = candidate;
      }
    }

    return nextLayouts;
  } catch {
    return INITIAL_WINDOWS;
  }
}

const stageStyles = `
  .opm-workspace {
    position: relative;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(circle at 18% 18%, rgba(0, 212, 255, 0.11), transparent 18%),
      radial-gradient(circle at 68% 72%, rgba(155, 77, 255, 0.12), transparent 16%),
      #000;
    overflow: hidden;
    color: rgba(255, 255, 255, 0.94);
  }

  .opm-workspace::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px);
    background-size: 44px 44px;
    opacity: 0.14;
    pointer-events: none;
  }

  .opm-toolbar {
    position: relative;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 14px 18px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    background: rgba(4, 6, 10, 0.82);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
  }

  .opm-viewport {
    position: relative;
    flex: 1;
    overflow: auto;
    padding: 20px;
  }

  .opm-board-shell {
    position: relative;
  }

  .opm-board {
    position: relative;
    transform-origin: top left;
  }

  .opm-window {
    overflow: hidden;
    border-radius: 26px;
    border: 1px solid rgba(0, 212, 255, 0.13);
    background: rgba(7, 10, 14, 0.86);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow:
      0 0 0 1px rgba(0, 212, 255, 0.04) inset,
      0 18px 50px rgba(0, 0, 0, 0.48),
      0 0 22px rgba(0, 212, 255, 0.08);
  }

  .opm-window::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at top right, rgba(0, 212, 255, 0.08), transparent 28%);
    pointer-events: none;
  }

  .opm-window-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 18px 12px;
    cursor: move;
    position: relative;
    z-index: 2;
  }

  .opm-window-title {
    font-size: 11px;
    letter-spacing: 0.34em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.52);
  }

  .opm-window-subtitle {
    margin-top: 5px;
    font-size: 12px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  .opm-window-body {
    position: relative;
    z-index: 2;
    height: calc(100% - 64px);
    padding: 0 18px 18px;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(0, 212, 255, 0.24) transparent;
  }

  .opm-window-body::-webkit-scrollbar,
  .opm-pattern-list::-webkit-scrollbar,
  .opm-trace-list::-webkit-scrollbar,
  .opm-viewport::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  .opm-window-body::-webkit-scrollbar-thumb,
  .opm-pattern-list::-webkit-scrollbar-thumb,
  .opm-trace-list::-webkit-scrollbar-thumb,
  .opm-viewport::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: rgba(0, 212, 255, 0.18);
  }

  .opm-rnd-handle {
    position: absolute;
    z-index: 30;
    pointer-events: auto;
  }

  .opm-rnd-handle.top,
  .opm-rnd-handle.bottom {
    left: 40px;
    right: 40px;
    height: 14px;
  }

  .opm-rnd-handle.left,
  .opm-rnd-handle.right {
    top: 40px;
    bottom: 40px;
    width: 14px;
  }

  .opm-rnd-handle.top { top: -7px; cursor: ns-resize; }
  .opm-rnd-handle.bottom { bottom: -7px; cursor: ns-resize; }
  .opm-rnd-handle.left { left: -7px; cursor: ew-resize; }
  .opm-rnd-handle.right { right: -7px; cursor: ew-resize; }

  .opm-rnd-handle.topLeft,
  .opm-rnd-handle.topRight,
  .opm-rnd-handle.bottomLeft,
  .opm-rnd-handle.bottomRight {
    width: 22px;
    height: 22px;
  }

  .opm-rnd-handle.topLeft { left: -8px; top: -8px; cursor: nwse-resize; }
  .opm-rnd-handle.topRight { right: -8px; top: -8px; cursor: nesw-resize; }
  .opm-rnd-handle.bottomLeft { left: -8px; bottom: -8px; cursor: nesw-resize; }
  .opm-rnd-handle.bottomRight { right: -8px; bottom: -8px; cursor: nwse-resize; }

  .opm-rnd-handle::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: rgba(0, 212, 255, 0.08);
    box-shadow: 0 0 0 1px rgba(0, 212, 255, 0.22) inset;
  }

  .opm-stage-panel {
    position: relative;
    height: 100%;
    border-radius: 24px;
    overflow: hidden;
    background:
      radial-gradient(circle at 50% 30%, rgba(0, 212, 255, 0.08), transparent 28%),
      rgba(255,255,255,0.02);
  }

  .opm-stage-feed {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: saturate(0.95) contrast(1.04) brightness(0.56);
    transform: scaleX(-1);
  }

  .opm-stage-secondary {
    position: absolute;
    right: 20px;
    top: 20px;
    width: 24%;
    height: 24%;
    min-width: 180px;
    min-height: 120px;
    border-radius: 20px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 14px 40px rgba(0,0,0,0.4);
    z-index: 4;
    background: rgba(5, 8, 12, 0.92);
  }

  .opm-stage-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(circle at center, rgba(0, 212, 255, 0.08), transparent 34%),
      linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)),
      rgba(4, 6, 10, 0.96);
    z-index: 12;
    pointer-events: auto;
  }

  .opm-stage-placeholder-card {
    max-width: 360px;
    border-radius: 22px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.03);
    padding: 18px 20px;
    text-align: center;
    box-shadow: 0 16px 40px rgba(0,0,0,0.36);
  }

  .opm-stage-overlay {
    position: absolute;
    inset: 0;
    z-index: 3;
    background:
      linear-gradient(180deg, rgba(0,0,0,0.08), rgba(0,0,0,0.32)),
      repeating-linear-gradient(to bottom, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 4px);
    pointer-events: none;
  }

  .opm-stage-overlay::after {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at center, rgba(0,212,255,0.06), transparent 42%);
  }

  .opm-stage-annotation {
    position: absolute;
    inset: 0;
    z-index: 5;
    pointer-events: none;
  }

  .opm-stage-annotation line {
    stroke: rgba(0, 212, 255, 0.34);
    stroke-width: 1.2;
  }

  .opm-stage-annotation .violet {
    stroke: rgba(155, 77, 255, 0.34);
  }

  .opm-stage-annotation circle {
    fill: #00d4ff;
    filter: drop-shadow(0 0 5px rgba(0,212,255,0.8));
  }

  .opm-stage-annotation circle.violet {
    fill: #9b4dff;
    filter: drop-shadow(0 0 5px rgba(155,77,255,0.8));
  }

  .opm-target {
    position: absolute;
    z-index: 5;
    border-radius: 18px;
    border: 1px solid rgba(0, 212, 255, 0.28);
    box-shadow: inset 0 0 18px rgba(0,212,255,0.06), 0 0 22px rgba(0,212,255,0.14);
    pointer-events: none;
  }

  .opm-target.violet {
    border-color: rgba(155, 77, 255, 0.28);
    box-shadow: inset 0 0 18px rgba(155,77,255,0.06), 0 0 22px rgba(155,77,255,0.14);
  }

  .opm-target::before,
  .opm-target::after {
    content: "";
    position: absolute;
    width: 18px;
    height: 18px;
    border-color: inherit;
  }

  .opm-target::before {
    left: -1px;
    top: -1px;
    border-left: 2px solid;
    border-top: 2px solid;
    border-top-left-radius: 16px;
  }

  .opm-target::after {
    right: -1px;
    bottom: -1px;
    border-right: 2px solid;
    border-bottom: 2px solid;
    border-bottom-right-radius: 16px;
  }

  .opm-tag {
    position: absolute;
    z-index: 6;
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(7,10,14,0.72);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    padding: 10px 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    pointer-events: none;
  }

  .opm-scan-bar {
    position: absolute;
    left: 4%;
    right: 4%;
    height: 3px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, rgba(0,212,255,0.94), transparent);
    box-shadow: 0 0 22px rgba(0,212,255,0.82);
    z-index: 4;
    animation: opm-scan 5.6s ease-in-out infinite;
  }

  .opm-au-grid {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 14px;
  }

  .opm-au-row {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 2px;
    justify-items: center;
  }

  .opm-au-row.shift {
    padding-left: 6%;
  }

  .opm-au-hex {
    width: clamp(54px, 7.5vw, 82px);
    aspect-ratio: 1.12 / 1;
    clip-path: polygon(25% 8%, 75% 8%, 100% 50%, 75% 92%, 25% 92%, 0 50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    transition: opacity 220ms ease, box-shadow 220ms ease, transform 220ms ease;
  }

  .opm-pattern-list,
  .opm-trace-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 16px;
    overflow: auto;
  }

  .opm-pattern-card,
  .opm-trace-card,
  .opm-mini-card {
    border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.03);
    padding: 14px 16px;
  }

  .opm-pill-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 16px;
  }

  .opm-pill {
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.06);
    background: rgba(255,255,255,0.04);
    padding: 14px 20px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 14px;
    letter-spacing: 0.08em;
  }

  .opm-mono {
    font-family: "JetBrains Mono", ui-monospace, monospace;
  }

  @keyframes opm-scan {
    0%, 100% { top: 12%; opacity: 0.2; }
    50% { top: 84%; opacity: 1; }
  }
`;

const modalityTone = {
  cross_modal: "#00d4ff",
  face_au: "#9b4dff",
  vocal: "#ffb84d",
  semantic: "#7bf7c7",
  body: "#5fe0ff",
} satisfies Record<Pattern["modality"], string>;

const windowTitle = {
  stage: { title: "PERCEPTION STAGE", subtitle: "Live call ingest / dual view", accent: "#00d4ff" },
  cygnus: { title: "CYGNUS LITE", subtitle: "Expression / tone / body signal field", accent: "#00d4ff" },
  oracle: { title: "ORACLE RT", subtitle: "Cross-model fusion / coherence", accent: "#9b4dff" },
  lucid: { title: "LUCID", subtitle: "State summary / synthesis relay", accent: "#00d4ff" },
  patterns: { title: "ACTIVE PATTERNS", subtitle: "Runtime pattern bus", accent: "#f0c219" },
  trace: { title: "SYSTEM TRACE", subtitle: "Latency / transport / key moments", accent: "#00d4ff" },
} satisfies Record<WindowId, { title: string; subtitle: string; accent: string }>;

function WindowShell({
  id,
  layout,
  onDragStop,
  onResizeStop,
  onFocus,
  children,
}: {
  id: WindowId;
  layout: WindowLayout;
  onDragStop: RndDragCallback;
  onResizeStop: RndResizeCallback;
  onFocus: () => void;
  children: React.ReactNode;
}) {
  const title = windowTitle[id];

  return (
    <Rnd
      size={{ width: layout.width, height: layout.height }}
      position={{ x: layout.x, y: layout.y }}
      minWidth={id === "stage" ? 700 : 320}
      minHeight={id === "patterns" ? 180 : 220}
      onDragStart={onFocus}
      onResizeStart={onFocus}
      onMouseDown={onFocus}
      onDragStop={onDragStop}
      onResizeStop={onResizeStop}
      dragHandleClassName="opm-window-header"
      style={{ zIndex: layout.z }}
      className="opm-window"
      enableResizing={{
        top: true,
        right: true,
        bottom: true,
        left: true,
        topRight: true,
        bottomRight: true,
        bottomLeft: true,
        topLeft: true,
      }}
      resizeHandleClasses={{
        top: "opm-rnd-handle top",
        right: "opm-rnd-handle right",
        bottom: "opm-rnd-handle bottom",
        left: "opm-rnd-handle left",
        topRight: "opm-rnd-handle topRight",
        bottomRight: "opm-rnd-handle bottomRight",
        bottomLeft: "opm-rnd-handle bottomLeft",
        topLeft: "opm-rnd-handle topLeft",
      }}
    >
      <div className="opm-window-header">
        <div>
          <p className="opm-window-title">{title.title}</p>
          <p className="opm-window-subtitle" style={{ color: title.accent }}>{title.subtitle}</p>
        </div>
        <div className="opm-mono text-[10px] uppercase tracking-[0.24em] text-white/36">
          drag / resize
        </div>
      </div>
      <div className="opm-window-body">{children}</div>
    </Rnd>
  );
}

function formatOracleLabel(value: string) {
  return value.replace(/_/g, " ");
}

function inferOracleDisplayModality(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("cross")) return "cross_modal" as const;
  if (normalized.includes("face") || normalized.includes("au")) return "face_au" as const;
  if (normalized.includes("vocal") || normalized.includes("voice") || normalized.includes("tone")) return "vocal" as const;
  if (normalized.includes("body") || normalized.includes("gesture") || normalized.includes("tension")) return "body" as const;
  return "semantic" as const;
}

function formatSignalValue(value: unknown) {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (typeof value === "number") {
    if (value >= 0 && value <= 1) {
      return `${Math.round(value * 100)}%`;
    }
    return Number.isInteger(value) ? `${value}` : value.toFixed(2);
  }
  if (value == null) {
    return "n/a";
  }
  return String(value);
}

export default function OPMPerceptionPanelPreviewScreen() {
  const searchParams = useMemo(
    () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
    [],
  );
  const [tick, setTick] = useState(0);
  const [layouts, setLayouts] = useState(() => readSavedLayouts());
  const [topZ, setTopZ] = useState(10);
  const [zoom, setZoom] = useState(0.82);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [dataSource, setDataSource] = useState<"LIVE OPM" | "FALLBACK MOCK">("FALLBACK MOCK");
  const [layoutSavedAt, setLayoutSavedAt] = useState<number | null>(null);
  const [motionTrack, setMotionTrack] = useState<MotionTrack>({ x: 0.5, y: 0.46, energy: 0 });
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureAdapterRef = useRef<ReturnType<typeof createCaptureAdapter> | null>(null);
  const analysisAdapterRef = useRef<ReturnType<typeof createPreviewAnalysisAdapter> | null>(null);
  const activeSessionId = searchParams.get("session")?.trim() || PREVIEW_FALLBACK_SESSION_ID;
  const endpointSessionId = searchParams.get("session")?.trim() || null;
  const perceptionBus = usePerceptionSession(activeSessionId);
  const cygnusStream = useCygnusStream(activeSessionId);
  const oracleStream = useOracleStream(activeSessionId);
  const lucidStream = useLucidStream(activeSessionId);
  const transportStream = usePerceptionStream(activeSessionId, "transport");

  const requestCamera = async () => {
    await captureAdapterRef.current?.start();
  };

  const stopCamera = () => {
    captureAdapterRef.current?.stop();
  };

  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 2400);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!perceptionBus) {
      return;
    }

    const adapter = createCaptureAdapter({
      sessionId: activeSessionId,
      participantId: PREVIEW_PARTICIPANT_ID,
      bus: perceptionBus,
    });
    const analysisAdapter = createPreviewAnalysisAdapter({
      sessionId: activeSessionId,
      participantId: PREVIEW_PARTICIPANT_ID,
      bus: perceptionBus,
    });
    captureAdapterRef.current = adapter;
    analysisAdapterRef.current = analysisAdapter;
    analysisAdapter.setEndpointSession(endpointSessionId);
    setDataSource(analysisAdapter.getDataSource());
    adapter.attachVideoElement(localVideoRef.current);
    adapter.attachAnalysisCanvas(analysisCanvasRef.current);

    const unsubscribe = adapter.subscribe((snapshot) => {
      setCameraReady(snapshot.cameraReady);
      setCameraLoading(snapshot.cameraLoading);
      setCameraError(snapshot.cameraError);
      setMotionTrack(snapshot.motionTrack);
    });

    void adapter.start();

    return () => {
      unsubscribe();
      adapter.destroy();
      captureAdapterRef.current = null;
      analysisAdapterRef.current = null;
    };
  }, [activeSessionId, endpointSessionId, perceptionBus]);

  useEffect(() => {
    analysisAdapterRef.current?.setEndpointSession(endpointSessionId);
    if (analysisAdapterRef.current) {
      setDataSource(analysisAdapterRef.current.getDataSource());
    }
  }, [endpointSessionId]);

  useEffect(() => {
    captureAdapterRef.current?.attachVideoElement(localVideoRef.current);
    captureAdapterRef.current?.attachAnalysisCanvas(analysisCanvasRef.current);
  }, [cameraReady]);

  const mockState = useMemo(() => buildPreviewState(tick), [tick]);

  const state = cygnusStream
    ? {
        expression: cygnusStream.face.dominantExpression,
        confidence: cygnusStream.face.confidence,
        tone: cygnusStream.vocal.energy,
        body: {
          chestContraction: `${cygnusStream.body.torso?.contraction ?? 0}%`,
          headPitch: `${Math.round(cygnusStream.face.headPose?.pitch ?? 0)}deg`,
          armPosition: mockState.body.armPosition,
          posture: cygnusStream.body.posture,
        },
        actionUnits: cygnusStream.face.actionUnits,
        patterns: oracleStream?.patterns ?? mockState.patterns,
        summary: lucidStream?.stateSummary ?? mockState.summary,
        activePatterns: (oracleStream?.patterns ?? mockState.patterns).map((pattern) => ({
          label: pattern.name,
          active: pattern.status !== "divergent",
        })),
        trace: lucidStream?.keyMoments.map((item) => ({
          timestamp: item.timestamp,
          event: item.event,
        })) ?? mockState.trace,
        latency: transportStream?.latencyMs ?? mockState.latency,
      }
    : mockState;
  const oracleRuleMatches = oracleStream?.ruleMatches ?? [];
  const oracleCorrections = oracleStream?.correctedEmotions ?? [];
  const oracleSignalContextEntries = Object.entries(oracleStream?.signalContext ?? {});
  const oracleFindings = oracleStream?.findings ?? [];
  const primarySignalContext = oracleSignalContextEntries[0]?.[1];
  const activeAuEntries = useMemo(
    () =>
      Object.entries(state.actionUnits)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
    [state.actionUnits],
  );
  const boardWidth = useMemo(
    () =>
      Math.max(
        MIN_BOARD_WIDTH,
        ...Object.values(layouts).map((layout) => layout.x + layout.width + 240),
      ),
    [layouts],
  );
  const boardHeight = useMemo(
    () =>
      Math.max(
        MIN_BOARD_HEIGHT,
        ...Object.values(layouts).map((layout) => layout.y + layout.height + 240),
      ),
    [layouts],
  );
  const stageAnchor = useMemo(() => {
    const x = clamp(motionTrack.x, 0.28, 0.72);
    const y = clamp(motionTrack.y, 0.22, 0.62);
    const bodyY = clamp(y + 0.3 + motionTrack.energy * 0.08, 0.48, 0.82);
    return {
      faceX: x,
      faceY: y,
      bodyX: clamp(x + (x > 0.5 ? -0.03 : 0.03), 0.24, 0.76),
      bodyY,
      faceTagLeft: clamp(x * 100 - 24, 8, 56),
      faceTagTop: clamp(y * 100 - 22, 8, 56),
      bodyTagLeft: clamp(x * 100 - 12, 42, 72),
      bodyTagTop: clamp(bodyY * 100 - 6, 56, 82),
      lockTagLeft: clamp(x * 100 - 28, 10, 44),
      lockTagBottom: clamp((1 - bodyY) * 100 + 2, 10, 24),
    };
  }, [motionTrack]);
  const motionLabel = motionTrack.energy > 0.24 ? "Motion spike + posture shift" : "Face mesh + posture stable";
  const bodyLabel = motionTrack.energy > 0.2 ? "Body drift + torso response" : "Body signal nominal";
  useEffect(() => {
    if (!analysisAdapterRef.current) {
      return;
    }
    analysisAdapterRef.current.publishFrame({
      tick,
      mockState,
      motionTrack,
      stageAnchor,
      cameraReady,
      cameraLoading,
      cameraError,
      videoWidth: localVideoRef.current?.videoWidth,
      videoHeight: localVideoRef.current?.videoHeight,
      motionLabel,
      bodyLabel,
    });
    setDataSource(analysisAdapterRef.current.getDataSource());
  }, [bodyLabel, cameraError, cameraLoading, cameraReady, mockState, motionLabel, motionTrack, stageAnchor, tick]);
  const saveLayouts = () => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layouts));
    setLayoutSavedAt(Date.now());
    perceptionBus?.publish("trace", {
      sessionId: activeSessionId,
      timestamp: Date.now(),
      stage: "transport",
      level: "info",
      message: "Workspace layout saved locally.",
      participantId: PREVIEW_PARTICIPANT_ID,
    });
  };

  const bringToFront = (id: WindowId) => {
    setTopZ((value) => value + 1);
    setLayouts((current) => ({
      ...current,
      [id]: { ...current[id], z: topZ + 1 },
    }));
  };

  const updateDrag = (id: WindowId): RndDragCallback => (...args) => {
    const data = args[1];
    setLayouts((current) => ({
      const next = {
        ...current,
        [id]: { ...current[id], x: data.x, y: data.y },
      };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(next));
        setLayoutSavedAt(Date.now());
      }
      return next;
    });
  };

  const updateResize = (id: WindowId): RndResizeCallback => (...args) => {
    const ref = args[2];
    const position = args[4];
    setLayouts((current) => ({
      const next = {
        ...current,
        [id]: {
          ...current[id],
          x: position.x,
          y: position.y,
          width: parseFloat(ref.style.width),
          height: parseFloat(ref.style.height),
        },
      };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(next));
        setLayoutSavedAt(Date.now());
      }
      return next;
    });
  };

  return (
    <>
      <style>{stageStyles}</style>
      <div className="opm-workspace">
        <div className="opm-toolbar">
          <div>
            <p className="opm-mono text-[11px] uppercase tracking-[0.34em] text-white/56">OPM workspace</p>
            <div className="mt-1 flex items-center gap-3 text-xs">
              <span
                className="opm-mono rounded-full border px-2.5 py-1 uppercase tracking-[0.18em]"
                style={{
                  borderColor: dataSource === "LIVE OPM" ? "rgba(0,212,255,0.32)" : "rgba(255,184,77,0.32)",
                  color: dataSource === "LIVE OPM" ? "#00d4ff" : "#ffb84d",
                  background: dataSource === "LIVE OPM" ? "rgba(0,212,255,0.08)" : "rgba(255,184,77,0.08)",
                }}
              >
                Data Source: {dataSource}
              </span>
              {endpointSessionId && (
                <span className="opm-mono text-white/46">session {endpointSessionId}</span>
              )}
              {layoutSavedAt && (
                <span className="text-white/46">Layout gespeichert</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={saveLayouts}
              className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/72 transition hover:bg-white/[0.08]"
            >
              Layout speichern
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (cameraReady) {
                  stopCamera();
                  return;
                }
                void requestCamera();
              }}
              disabled={cameraLoading}
              className="rounded-full border border-[#00d4ff]/30 bg-[#00d4ff]/10 px-4 py-2 text-sm text-[#00d4ff] transition hover:bg-[#00d4ff]/16 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {cameraLoading ? "Kamera ..." : cameraReady ? "Kamera aus" : "Kamera verbinden"}
            </button>
            <button
              type="button"
              onClick={() => setZoom((value) => clamp(value - 0.08, 0.55, 1.2))}
              className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/72"
            >
              Zoom -
            </button>
            <div className="opm-mono min-w-[76px] text-center text-sm text-[#00d4ff]">{Math.round(zoom * 100)}%</div>
            <button
              type="button"
              onClick={() => setZoom((value) => clamp(value + 0.08, 0.55, 1.2))}
              className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/72"
            >
              Zoom +
            </button>
          </div>
        </div>

        <div className="opm-viewport">
          <div className="opm-board-shell" style={{ width: boardWidth * zoom, height: boardHeight * zoom }}>
            <div className="opm-board" style={{ width: boardWidth, height: boardHeight, transform: `scale(${zoom})` }}>
        <WindowShell
          id="stage"
          layout={layouts.stage}
          onFocus={() => bringToFront("stage")}
          onDragStop={updateDrag("stage")}
          onResizeStop={updateResize("stage")}
        >
          <div className="opm-stage-panel">
            {cameraReady ? (
              <video ref={localVideoRef} className="opm-stage-feed" autoPlay muted playsInline />
            ) : (
              <div className="opm-stage-placeholder">
                <div className="opm-stage-placeholder-card">
                  <p className="opm-mono text-[11px] uppercase tracking-[0.24em] text-white/42">Live camera stage</p>
                  <p className="mt-3 text-lg text-white">
                    {cameraLoading ? "Kamera wird verbunden" : "Kamera wartet auf Freigabe"}
                  </p>
                  <p className="mt-3 text-sm leading-6 text-white/66">
                    {cameraError ?? "Gib im Browser den Kamera-Zugriff frei, damit hier dein echter Live-Feed erscheint."}
                  </p>
                  <button
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void requestCamera();
                    }}
                    disabled={cameraLoading}
                    className="mt-5 rounded-full border border-[#00d4ff]/30 bg-[#00d4ff]/10 px-5 py-2.5 text-sm text-[#00d4ff] transition hover:bg-[#00d4ff]/16 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {cameraLoading ? "Kamera wird angefragt ..." : "Kamera erneut anfragen"}
                  </button>
                </div>
              </div>
            )}
            <div className="opm-stage-secondary">
              <div className="opm-stage-placeholder">
                <div className="opm-stage-placeholder-card">
                  <p className="opm-mono text-[10px] uppercase tracking-[0.22em] text-white/42">Remote participant</p>
                  <p className="mt-3 text-base text-white">Endpoint slot ready</p>
                  <p className="mt-2 text-xs leading-5 text-white/60">
                    Connect the remote call/video endpoint here next.
                  </p>
                </div>
              </div>
            </div>
            <div className="opm-stage-overlay" />
            <svg className="opm-stage-annotation" viewBox="0 0 1000 700" preserveAspectRatio="none" aria-hidden="true">
              <line x1="128" y1="124" x2={stageAnchor.faceX * 1000} y2={stageAnchor.faceY * 700} />
              <circle cx={stageAnchor.faceX * 1000} cy={stageAnchor.faceY * 700} r="4" />
              <line className="violet" x1="780" y1="540" x2={stageAnchor.bodyX * 1000} y2={stageAnchor.bodyY * 700} />
              <circle className="violet" cx={stageAnchor.bodyX * 1000} cy={stageAnchor.bodyY * 700} r="4" />
              <line x1="148" y1="600" x2={stageAnchor.bodyX * 1000} y2={stageAnchor.bodyY * 700} />
              <circle cx={stageAnchor.bodyX * 1000} cy={stageAnchor.bodyY * 700} r="4" />
              <line className="violet" x1="770" y1="132" x2="650" y2="208" />
              <circle className="violet" cx="650" cy="208" r="4" />
            </svg>
            <div className="opm-scan-bar" />

            <motion.div
              animate={{ x: [0, 4, -3, 0], y: [0, -3, 4, 0] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
              className="opm-target"
              style={{
                left: `${stageAnchor.faceX * 100 - 14}%`,
                top: `${stageAnchor.faceY * 100 - 16}%`,
                width: `${28 + motionTrack.energy * 5}%`,
                height: `${30 + motionTrack.energy * 6}%`,
              }}
            />
            <motion.div
              animate={{ x: [0, -4, 4, 0], y: [0, 4, -4, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="opm-target violet"
              style={{
                left: `${stageAnchor.bodyX * 100 - 18}%`,
                top: `${stageAnchor.bodyY * 100 - 20}%`,
                width: `${38 + motionTrack.energy * 8}%`,
                height: `${42 + motionTrack.energy * 8}%`,
              }}
            />
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              key={`face-${tick}`}
              className="opm-tag"
              style={{ left: `${stageAnchor.faceTagLeft}%`, top: `${stageAnchor.faceTagTop}%` }}
            >
              <p className="opm-mono text-[10px] uppercase tracking-[0.24em] text-white/40">Face mesh / posture</p>
              <p className="mt-2 text-sm text-[#00d4ff]">{motionLabel}</p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              key={`speaker-${tick}`}
              className="opm-tag"
              style={{ left: `${stageAnchor.bodyTagLeft}%`, top: `${stageAnchor.bodyTagTop}%` }}
            >
              <p className="opm-mono text-[10px] uppercase tracking-[0.24em] text-white/40">Body signal / live scan</p>
              <p className="mt-2 text-sm text-[#9b4dff]">{bodyLabel}</p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              key={`lock-${tick}`}
              className="opm-tag"
              style={{ left: `${stageAnchor.lockTagLeft}%`, bottom: `${stageAnchor.lockTagBottom}%` }}
            >
              <p className="opm-mono text-[10px] uppercase tracking-[0.24em] text-white/40">Live lock</p>
              <p className="mt-2 text-sm text-white">{state.patterns[0]?.name}</p>
              <p className="opm-mono mt-2 text-[11px] uppercase tracking-[0.18em] text-[#00d4ff]">
                {Math.round(state.patterns[0]?.confidence * 100)}% confidence
              </p>
            </motion.div>
            <canvas ref={analysisCanvasRef} className="hidden" />
          </div>
        </WindowShell>

        <WindowShell
          id="cygnus"
          layout={layouts.cygnus}
          onFocus={() => bringToFront("cygnus")}
          onDragStop={updateDrag("cygnus")}
          onResizeStop={updateResize("cygnus")}
        >
          <div className="grid h-full grid-cols-[220px_1fr] gap-5">
            <div>
              <div
                className="flex h-[92px] items-center justify-center rounded-[24px] px-4 text-center text-[18px] font-semibold uppercase tracking-[0.22em] text-white"
                style={{
                  border: "1px solid rgba(0, 212, 255, 0.2)",
                  background: "linear-gradient(180deg, rgba(0,212,255,0.1), rgba(155,77,255,0.08))",
                }}
              >
                {state.expression}
              </div>

              <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4">
                <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Sync confidence</p>
                <div className="mt-3 flex items-center gap-4">
                  <svg viewBox="0 0 120 120" className="h-[118px] w-[118px] -rotate-90">
                    <circle cx="60" cy="60" r="48" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                    <circle
                      cx="60"
                      cy="60"
                      r="48"
                      fill="none"
                      stroke="#00d4ff"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeDasharray={2 * Math.PI * 48}
                      strokeDashoffset={(2 * Math.PI * 48) * (1 - state.confidence)}
                      style={{ filter: "drop-shadow(0 0 8px rgba(0,212,255,0.7))" }}
                    />
                  </svg>
                  <div>
                    <p className="text-3xl font-semibold text-white">{Math.round(state.confidence * 100)}</p>
                    <p className="opm-mono text-[11px] uppercase tracking-[0.2em] text-white/46">confidence</p>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-3">
                <div className="opm-mini-card">
                  <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Affective tone</p>
                  <p className="mt-2 text-lg text-white">{toneLabel(state.tone)}</p>
                  <div className="mt-3 h-2 rounded-full bg-white/8">
                    <div
                      className="h-full rounded-full bg-[#00d4ff]"
                      style={{ width: `${Math.round(state.tone * 100)}%`, boxShadow: "0 0 12px rgba(0,212,255,0.8)" }}
                    />
                  </div>
                </div>

                <div className="opm-mini-card">
                  <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Body signal</p>
                  <div className="mt-3 space-y-2 text-sm text-white/78">
                    <div className="flex justify-between gap-3"><span>Chest contraction</span><span className="opm-mono">{state.body.chestContraction}</span></div>
                    <div className="flex justify-between gap-3"><span>Head pitch</span><span className="opm-mono">{state.body.headPitch}</span></div>
                    <div className="flex justify-between gap-3"><span>Arm position</span><span className="opm-mono text-right">{state.body.armPosition}</span></div>
                  </div>
                </div>
              </div>
            </div>

            <div className="min-w-0">
              <div className="flex items-center justify-between">
                <p className="opm-mono text-[10px] uppercase tracking-[0.24em] text-white/38">Full AU field</p>
                <p className="opm-mono text-[10px] uppercase tracking-[0.24em] text-white/38">
                  {activeAuEntries.filter(([, value]) => value >= 0.55).length} firing
                </p>
              </div>

              <div className="opm-au-grid">
                {[PREVIEW_ALL_ACTION_UNITS.slice(0, 6), PREVIEW_ALL_ACTION_UNITS.slice(6, 12), PREVIEW_ALL_ACTION_UNITS.slice(12, 18), PREVIEW_ALL_ACTION_UNITS.slice(18, 24), PREVIEW_ALL_ACTION_UNITS.slice(24, 30), PREVIEW_ALL_ACTION_UNITS.slice(30, 36), PREVIEW_ALL_ACTION_UNITS.slice(36, 42), [null, "AU43", "AU44", "AU45", "AU46", null] as Array<string | null>].map((row, rowIndex) => (
                  <div
                    key={`au-row-${rowIndex}`}
                    className={`opm-au-row${rowIndex % 2 === 1 ? " shift" : ""}`}
                    style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}
                  >
                    {row.map((unit, columnIndex) => {
                      if (!unit) {
                        return <div key={`empty-${rowIndex}-${columnIndex}`} className="h-[58px] w-[64px]" />;
                      }

                      const value = state.actionUnits[unit] ?? 0;
                      const isActive = value >= 0.34;
                      const isHot = value >= 0.8;

                      return (
                        <div
                          key={unit}
                          className="opm-au-hex"
                          style={{
                            background: isActive ? "rgba(155,77,255,0.28)" : "rgba(255,255,255,0.015)",
                            border: isActive ? "1px solid rgba(155,77,255,0.28)" : "1px solid rgba(255,255,255,0.03)",
                            boxShadow: isActive ? `0 0 ${10 + value * 18}px rgba(155,77,255,${0.12 + value * 0.14})` : "none",
                            opacity: isActive ? 0.98 : 0.24,
                            transform: isHot ? "translateY(-1px)" : "none",
                          }}
                        >
                          <span className="opm-mono text-[10px] uppercase tracking-[0.1em] text-white/82">{unit}</span>
                          <span className="opm-mono text-[10px]" style={{ color: isActive ? "#f1ddff" : "rgba(255,255,255,0.22)" }}>
                            {Math.round(value * 100)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </WindowShell>

        <WindowShell
          id="oracle"
          layout={layouts.oracle}
          onFocus={() => bringToFront("oracle")}
          onDragStop={updateDrag("oracle")}
          onResizeStop={updateResize("oracle")}
        >
          <div className="grid h-full grid-cols-[250px_1fr] gap-5">
            <div className="space-y-3">
              <div className="opm-mini-card">
                <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Fusion target</p>
                <p className="mt-2 text-lg text-white">Face + voice + body + text</p>
                <p className="mt-2 text-sm leading-6 text-white/56">
                  Structured ORACLE output from raw OPM findings.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: "Rule matches", value: oracleRuleMatches.length, tone: modalityTone.cross_modal },
                  { label: "Corrections", value: oracleCorrections.length, tone: "#ff6b6b" },
                  { label: "Signal contexts", value: oracleSignalContextEntries.length, tone: modalityTone.body },
                  { label: "Findings", value: oracleFindings.length, tone: modalityTone.semantic },
                ].map((item) => (
                  <div key={item.label} className="opm-mini-card">
                    <p className="opm-mono text-[10px] uppercase tracking-[0.18em] text-white/38">{item.label}</p>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-2xl font-semibold text-white">{item.value}</span>
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: item.tone, boxShadow: `0 0 12px ${item.tone}` }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="opm-mini-card">
                <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Primary signal context</p>
                {primarySignalContext ? (
                  <div className="mt-3 space-y-2 text-sm text-white/78">
                    <div className="flex items-center justify-between gap-3"><span>Face</span><span className="opm-mono text-white/88">{primarySignalContext.faceTop ?? "n/a"}</span></div>
                    <div className="flex items-center justify-between gap-3"><span>Text</span><span className="opm-mono text-white/88">{primarySignalContext.textTop ?? "n/a"}</span></div>
                    <div className="flex items-center justify-between gap-3"><span>Voice stability</span><span className="opm-mono text-white/88">{formatSignalValue(primarySignalContext.voiceStability)}</span></div>
                    <div className="flex items-center justify-between gap-3"><span>Self touch</span><span className="opm-mono text-white/88">{formatSignalValue(primarySignalContext.hasSelfTouch)}</span></div>
                    <div className="flex items-center justify-between gap-3"><span>Tension</span><span className="opm-mono text-white/88">{formatSignalValue(primarySignalContext.hasTension)}</span></div>
                  </div>
                ) : (
                  <p className="mt-3 text-sm leading-6 text-white/56">No person signal context in this session window yet.</p>
                )}
              </div>
            </div>

            <div className="min-w-0 overflow-hidden">
              <div className="opm-pattern-list h-full space-y-4">
                <div>
                  <p className="opm-mono text-[10px] uppercase tracking-[0.22em] text-white/38">Rule matches</p>
                  <div className="mt-3 space-y-3">
                    {oracleRuleMatches.length > 0 ? oracleRuleMatches.map((match) => {
                      const tone = modalityTone[inferOracleDisplayModality(match.modalities.join(" ") || match.category || match.rule)];
                      return (
                        <motion.div
                          key={`${match.rule}-${match.personId ?? "p"}-${match.confidence}`}
                          initial={{ opacity: 0.5, x: 16 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.35 }}
                          className="opm-pattern-card"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="text-[17px] font-medium text-white">{formatOracleLabel(match.rule)}</p>
                              <p className="opm-mono mt-2 text-[11px] uppercase tracking-[0.18em] text-white/42">
                                {formatOracleLabel(match.category)} · {formatOracleLabel(String(match.status))}
                              </p>
                              {match.explanation && (
                                <p className="mt-3 text-sm leading-6 text-white/66">{match.explanation}</p>
                              )}
                              {match.signalsUsed && (
                                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-white/58">
                                  {Object.entries(match.signalsUsed).slice(0, 6).map(([key, value]) => (
                                    <div key={key} className="flex items-center justify-between gap-2">
                                      <span className="opm-mono uppercase tracking-[0.14em] text-white/34">{formatOracleLabel(key)}</span>
                                      <span className="opm-mono text-white/78">{formatSignalValue(value)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="shrink-0 text-right">
                              <span
                                className="opm-mono rounded-full px-3 py-1.5 text-[10px] uppercase tracking-[0.2em]"
                                style={{ color: tone, border: `1px solid ${tone}33`, background: `${tone}12` }}
                              >
                                {(match.modalities[0] ?? "cross_modal").replace("_", " ")}
                              </span>
                              <p className="opm-mono mt-2 text-[14px] text-white/78">{Math.round(match.confidence * 100)}%</p>
                              {match.originalEmotion && match.correctedEmotion && (
                                <p className="mt-2 text-xs text-white/54">
                                  {formatOracleLabel(match.originalEmotion)} → {formatOracleLabel(match.correctedEmotion)}
                                </p>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      );
                    }) : (
                      <div className="opm-pattern-card">
                        <p className="text-sm leading-6 text-white/56">No structured rule matches in this session window yet.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="opm-mini-card">
                    <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Corrected emotions</p>
                    <div className="mt-3 space-y-3">
                      {oracleCorrections.length > 0 ? oracleCorrections.map((item, index) => (
                        <div key={`${item.ruleName ?? "correction"}-${index}`} className="rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-3">
                          <p className="text-sm text-white">{formatOracleLabel(item.originalEmotion)} → <span className="text-[#00d4ff]">{formatOracleLabel(item.correctedEmotion)}</span></p>
                          <p className="opm-mono mt-2 text-[10px] uppercase tracking-[0.18em] text-white/42">
                            {(item.ruleName && formatOracleLabel(item.ruleName)) || "emotion correction"}{typeof item.confidence === "number" ? ` · ${Math.round(item.confidence * 100)}%` : ""}
                          </p>
                        </div>
                      )) : (
                        <p className="text-sm leading-6 text-white/56">No emotion corrections reported.</p>
                      )}
                    </div>
                  </div>

                  <div className="opm-mini-card">
                    <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Signal context</p>
                    <div className="mt-3 space-y-3">
                      {oracleSignalContextEntries.length > 0 ? oracleSignalContextEntries.map(([personId, context]) => (
                        <div key={personId} className="rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-3">
                          <p className="opm-mono text-[10px] uppercase tracking-[0.18em] text-white/42">Person {personId}</p>
                          <div className="mt-2 space-y-2 text-sm text-white/72">
                            <div className="flex items-center justify-between gap-3"><span>Face</span><span className="opm-mono">{context.faceTop ?? "n/a"}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Text</span><span className="opm-mono">{context.textTop ?? "n/a"}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Voice</span><span className="opm-mono">{formatSignalValue(context.voiceStability)}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Self touch</span><span className="opm-mono">{formatSignalValue(context.hasSelfTouch)}</span></div>
                          </div>
                        </div>
                      )) : (
                        <p className="text-sm leading-6 text-white/56">No per-person signal context available.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </WindowShell>

        <WindowShell
          id="lucid"
          layout={layouts.lucid}
          onFocus={() => bringToFront("lucid")}
          onDragStop={updateDrag("lucid")}
          onResizeStop={updateResize("lucid")}
        >
          <div className="grid h-full grid-cols-[1.3fr_0.7fr] gap-4">
            <div className="rounded-[22px] border border-white/8 bg-black/30 px-5 py-5">
              <p className="opm-mono text-[10px] uppercase tracking-[0.22em] text-white/38">Live synthesis</p>
              <motion.p
                key={`summary-${tick}`}
                initial={{ opacity: 0.6 }}
                animate={{ opacity: 1 }}
                className="opm-mono mt-4 text-[18px] leading-9 text-white/88"
              >
                {state.summary}
                <span className="ml-[2px] inline-block h-5 w-[1px] animate-pulse bg-[#00d4ff] align-middle" />
              </motion.p>
            </div>
            <div className="space-y-3">
              <div className="opm-mini-card">
                <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Relay target</p>
                <p className="mt-2 text-white">TTS / avatar / downstream handoff</p>
              </div>
              <div className="opm-mini-card">
                <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Reason trace</p>
                <div className="mt-3 space-y-2 text-sm text-white/76">
                  <p>speech content is mostly consistent with vocal charge</p>
                  <p>body tension remains higher than verbal calm claim</p>
                  <p>Lucid keeps summary cautious, not absolute</p>
                </div>
              </div>
            </div>
          </div>
        </WindowShell>

        <WindowShell
          id="patterns"
          layout={layouts.patterns}
          onFocus={() => bringToFront("patterns")}
          onDragStop={updateDrag("patterns")}
          onResizeStop={updateResize("patterns")}
        >
          <div className="h-full overflow-auto">
            <div className="opm-pill-grid">
              {state.activePatterns.map((pattern) => (
                <motion.div
                  key={`${pattern.label}-${pattern.active}`}
                  initial={{ opacity: 0.5, scale: 0.96 }}
                  animate={{ opacity: pattern.active ? 1 : 0.34, scale: pattern.active ? 1 : 0.98 }}
                  transition={{ duration: 0.3 }}
                  className="opm-pill"
                  style={{
                    color: pattern.active ? "rgba(255,255,255,0.82)" : "rgba(255,255,255,0.34)",
                    boxShadow: pattern.active ? "0 0 18px rgba(255,255,255,0.05)" : "none",
                  }}
                >
                  {pattern.label}
                </motion.div>
              ))}
            </div>
          </div>
        </WindowShell>

        <WindowShell
          id="trace"
          layout={layouts.trace}
          onFocus={() => bringToFront("trace")}
          onDragStop={updateDrag("trace")}
          onResizeStop={updateResize("trace")}
        >
          <div className="grid h-full grid-rows-[auto_1fr] gap-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="opm-mini-card">
                <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Latency</p>
                <p className="mt-2 text-2xl text-white">{state.latency} ms</p>
              </div>
              <div className="opm-mini-card">
                <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Injection</p>
                <p className="mt-2 text-2xl text-[#22c55e]">success</p>
              </div>
              <div className="opm-mini-card">
                <p className="opm-mono text-[10px] uppercase tracking-[0.2em] text-white/38">Speaker</p>
                <p className="mt-2 text-2xl text-white">{tick % 2 === 0 ? "A" : "B"}</p>
              </div>
            </div>

            <div className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-4">
              <p className="opm-mono text-[10px] uppercase tracking-[0.22em] text-white/38">Key moments</p>
              <div className="opm-trace-list mt-4 h-[calc(100%-28px)] pr-1">
                {state.trace.map((item, index) => (
                  <div key={`${item.timestamp}-${item.event}`} className="grid grid-cols-[70px_1fr] gap-3">
                    <span className="opm-mono text-[12px] text-white/56" style={{ opacity: Math.max(0.35, 1 - index * 0.14) }}>
                      {item.timestamp}
                    </span>
                    <span className="text-[14px] leading-6 text-white/82" style={{ opacity: Math.max(0.35, 1 - index * 0.14) }}>
                      {item.event}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </WindowShell>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
