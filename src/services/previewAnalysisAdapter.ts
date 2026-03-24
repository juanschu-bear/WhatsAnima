import type { PerceptionSessionBus } from "../lib/sessionBus";
import type {
  OracleCorrectedEmotion,
  OracleFinding,
  CygnusOutput,
  LucidOutput,
  OracleOutput,
  OraclePattern,
  OracleRuleMatch,
  OracleSignalContext,
} from "../types/perception";
import type { MotionTrack } from "./captureAdapter";

type PreviewPattern = OraclePattern;

export type PreviewMockState = {
  expression: string;
  summary: string;
  actionUnits: Record<string, number>;
  patterns: PreviewPattern[];
  confidence: number;
  tone: number;
  body: {
    chestContraction: string;
    headPitch: string;
    armPosition: string;
    posture: string;
  };
  trace: Array<{
    timestamp: string;
    event: string;
  }>;
  activePatterns: Array<{
    label: string;
    active: boolean;
  }>;
  latency: number;
};

type StageAnchor = {
  faceX: number;
  faceY: number;
};

type PreviewAnalysisAdapterOptions = {
  sessionId: string;
  participantId: string;
  bus: PerceptionSessionBus;
};

export type PreviewDataSource = "LIVE OPM" | "FALLBACK MOCK";

type PublishFrameInput = {
  tick: number;
  mockState: PreviewMockState;
  motionTrack: MotionTrack;
  stageAnchor: StageAnchor;
  cameraReady: boolean;
  cameraLoading: boolean;
  cameraError: string | null;
  videoWidth?: number;
  videoHeight?: number;
  motionLabel: string;
  bodyLabel: string;
};

type OpmRawPayload = {
  session_id?: string;
  timestamp?: number;
  cygnus?: string;
  oracle?: string;
  lucid?: string;
  oracle_rt?: string | Record<string, unknown>;
  oracle_structured?: Record<string, unknown>;
  latency_ms?: number;
  frame_count?: number;
  analysis_window_seconds?: number;
  speaker_name?: string;
  speaker?: string;
};

type ParsedPerception = {
  cygnus: CygnusOutput;
  oracle: OracleOutput;
  lucid: LucidOutput;
  latencyMs?: number;
};

const EXPRESSIONS = [
  "Calibrated Curiosity",
  "Intent Focus",
  "Measured Resolve",
  "Adaptive Engagement",
];

const SUMMARIES = [
  "Lucid synthesis indicates stable engagement with elevated curiosity and a low-friction response loop across the last exchange.",
  "Cross-channel coherence remains high. Spoken content, affective tone, and visible expression are mostly aligned with only minor tension bleed.",
  "Subject presents increasing intentionality. Voice cadence and embodied signal have tightened around the same semantic target.",
  "Interaction remains productive, but Oracle flags brief mismatches between verbal framing and micro-expressive tension before recovery.",
];

const KEY_MOMENTS = [
  "Cross-modal lock increased",
  "Voice cadence tightened",
  "Chest contraction dropped",
  "Brow tension rose",
  "Head pitch normalized",
  "Posture openness increased",
  "Semantic confidence climbed",
  "Delivery latency reduced",
];

const PATTERN_BANK: Array<Omit<PreviewPattern, "confidence" | "status">> = [
  { name: "Cross-modal sync", modality: "cross_modal" },
  { name: "Micro-expression detected", modality: "face_au" },
  { name: "Vocal stress pattern", modality: "vocal" },
  { name: "Semantic pressure", modality: "semantic" },
  { name: "Embodied tension release", modality: "cross_modal" },
  { name: "Cadence compression", modality: "vocal" },
  { name: "Brow conflict spike", modality: "face_au" },
];

const POLL_INTERVAL_MS = 5000;

export const PREVIEW_ALL_ACTION_UNITS = Array.from(
  { length: 46 },
  (_, index) => `AU${String(index + 1).padStart(2, "0")}`,
);

function clamp(value: number, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function normalizeWhitespace(value: string) {
  return value.replace(/\r/g, "").trim();
}

function splitLines(value: string) {
  return normalizeWhitespace(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function coerceRatio(raw: string | undefined, fallback: number) {
  if (!raw) {
    return fallback;
  }
  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return clamp(numeric > 1 ? numeric / 100 : numeric);
}

function coerceSignedNumber(raw: string | undefined, fallback = 0) {
  if (!raw) {
    return fallback;
  }
  const numeric = Number.parseFloat(raw);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function inferPatternModality(value: string): PreviewPattern["modality"] {
  const normalized = value.toLowerCase();
  if (normalized.includes("cross")) return "cross_modal";
  if (normalized.includes("face") || normalized.includes("au")) return "face_au";
  if (normalized.includes("vocal") || normalized.includes("tone") || normalized.includes("cadence")) return "vocal";
  if (normalized.includes("body") || normalized.includes("posture") || normalized.includes("gesture")) return "body";
  return "semantic";
}

function inferPatternStatus(confidence: number, text: string): PreviewPattern["status"] {
  const normalized = text.toLowerCase();
  if (normalized.includes("diverg") || normalized.includes("mismatch") || normalized.includes("conflict")) {
    return "divergent";
  }
  if (normalized.includes("watch") || normalized.includes("flag")) {
    return "watch";
  }
  if (confidence > 0.8) return "aligned";
  if (confidence > 0.62) return "watch";
  return "divergent";
}

function extractRawPayload(data: unknown): OpmRawPayload | null {
  if (!data) {
    return null;
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const result = extractRawPayload(item);
      if (result) {
        return result;
      }
    }
    return null;
  }

  if (typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  const hasRawShape =
    typeof record.cygnus === "string"
    || typeof record.oracle === "string"
    || typeof record.lucid === "string"
    || typeof record.oracle_rt === "string"
    || (typeof record.oracle_rt === "object" && record.oracle_rt !== null)
    || (typeof record.oracle_structured === "object" && record.oracle_structured !== null);

  if (hasRawShape) {
    return {
      session_id: typeof record.session_id === "string" ? record.session_id : undefined,
      timestamp: typeof record.timestamp === "number" ? record.timestamp : undefined,
      cygnus: typeof record.cygnus === "string" ? record.cygnus : undefined,
      oracle: typeof record.oracle === "string" ? record.oracle : undefined,
      lucid: typeof record.lucid === "string" ? record.lucid : undefined,
      oracle_rt:
        typeof record.oracle_rt === "string" || (typeof record.oracle_rt === "object" && record.oracle_rt !== null)
          ? (record.oracle_rt as string | Record<string, unknown>)
          : undefined,
      oracle_structured:
        typeof record.oracle_structured === "object" && record.oracle_structured !== null
          ? (record.oracle_structured as Record<string, unknown>)
          : undefined,
      latency_ms: typeof record.latency_ms === "number" ? record.latency_ms : undefined,
      frame_count: typeof record.frame_count === "number" ? record.frame_count : undefined,
      analysis_window_seconds:
        typeof record.analysis_window_seconds === "number"
          ? record.analysis_window_seconds
          : undefined,
      speaker_name: typeof record.speaker_name === "string" ? record.speaker_name : undefined,
      speaker: typeof record.speaker === "string" ? record.speaker : undefined,
    };
  }

  for (const value of Object.values(record)) {
    const nested = extractRawPayload(value);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export function toneLabel(value: number) {
  if (value > 0.78) return "High affect tone";
  if (value > 0.58) return "Measured affect";
  return "Subdued affect";
}

export function buildPreviewState(tick: number): PreviewMockState {
  const activeCenter = (tick * 5) % PREVIEW_ALL_ACTION_UNITS.length;
  const actionUnits = Object.fromEntries(
    PREVIEW_ALL_ACTION_UNITS.map((unit, index) => {
      const ringDistance = Math.min(
        Math.abs(index - activeCenter),
        PREVIEW_ALL_ACTION_UNITS.length - Math.abs(index - activeCenter),
      );
      const pulse = (Math.sin(tick * 0.58 + index * 0.78) + 1) / 2;
      const base = ringDistance > 10 ? 0.01 : 0.04;
      const activeBoost = ringDistance <= 2 ? 0.54 : ringDistance <= 5 ? 0.28 : 0;
      return [unit, clamp(base + activeBoost + pulse * (ringDistance <= 5 ? 0.22 : 0.05))];
    }),
  );

  const patterns = PATTERN_BANK.slice(0, 5).map((pattern, index) => {
    const confidence = clamp(0.54 + ((Math.sin(tick * 0.72 + index) + 1) / 2) * 0.4);
    return {
      ...pattern,
      confidence,
      status: confidence > 0.8 ? "aligned" : confidence > 0.62 ? "watch" : "divergent",
    } satisfies PreviewPattern;
  });

  return {
    expression: EXPRESSIONS[tick % EXPRESSIONS.length],
    summary: SUMMARIES[tick % SUMMARIES.length],
    actionUnits,
    patterns,
    confidence: clamp(0.78 + Math.sin(tick * 0.45) * 0.12),
    tone: clamp(0.52 + ((Math.sin(tick * 0.66 + 1.3) + 1) / 2) * 0.42),
    body: {
      chestContraction: `${(1.1 + Math.sin(tick * 0.43) * 0.9).toFixed(1)}%`,
      headPitch: `${Math.round(6 + Math.sin(tick * 0.52) * 7)}deg`,
      armPosition: tick % 2 === 0 ? "Open / responsive" : "Guarded / contracting",
      posture: tick % 3 === 0 ? "Forward engaged" : "Balanced neutral",
    },
    trace: Array.from({ length: 6 }, (_, index) => ({
      timestamp: `00:${String(26 - index * 4 - (tick % 3)).padStart(2, "0")}`,
      event: KEY_MOMENTS[(tick + index) % KEY_MOMENTS.length],
    })),
    activePatterns: [
      "Attention shift",
      "Micro-expression detected",
      "Vocal stress pattern",
      "Emotional resonance",
      "Cross-modal sync",
      "Response lock",
      "Body-speech mismatch",
    ].map((label, index) => ({ label, active: (tick + index) % 4 !== 0 })),
    latency: 96 + Math.round(((Math.sin(tick * 0.45) + 1) / 2) * 112),
  };
}

function parseLucidBlocks(section: string) {
  const markdown = normalizeWhitespace(section);
  const sectionPattern = /^##\s+(.+?)\n([\s\S]*?)(?=^##\s+|\Z)/gm;
  const blocks: Record<string, string> = {};
  for (const match of markdown.matchAll(sectionPattern)) {
    const heading = match[1]?.trim().toLowerCase();
    const body = normalizeWhitespace(match[2] ?? "");
    if (heading) {
      blocks[heading] = body;
    }
  }
  return blocks;
}

function parseCygnusSection(
  sessionId: string,
  participantId: string,
  section: string,
  fallback: PreviewMockState,
  motionTrack: MotionTrack,
  stageAnchor: StageAnchor,
): CygnusOutput {
  const lines = splitLines(section);
  const actionUnits = { ...fallback.actionUnits };
  const auPattern = /AU\s*0?(\d{1,2})[^0-9\-]*(\d{1,3}(?:\.\d+)?)\s*%?/gi;
  let auMatch: RegExpExecArray | null;
  while ((auMatch = auPattern.exec(section)) !== null) {
    const unit = `AU${auMatch[1].padStart(2, "0")}`;
    actionUnits[unit] = coerceRatio(auMatch[2], actionUnits[unit] ?? 0);
  }

  const personLine = lines.find((line) => /dominant expression/i.test(line));
  const dominantExpressionMatch = section.match(/dominant expression\s+([a-z _-]+?)\s*\((\d{1,3}(?:\.\d+)?)%\)/i);
  const dominantExpression =
    dominantExpressionMatch?.[1]?.trim()
    ?? lines.find((line) => /^dominant expression/i.test(line))?.split(/[:\-]/).slice(1).join(":").trim()
    ?? lines.find((line) => /^expression/i.test(line))?.split(/[:\-]/).slice(1).join(":").trim()
    ?? lines[0]
    ?? fallback.expression;

  const confidenceMatch =
    dominantExpressionMatch
    ?? section.match(/confidence[^0-9]*(\d{1,3}(?:\.\d+)?)\s*%?/i);
  const toneMatch = section.match(/(?:affective tone|tone)[^:\n]*[:\-]\s*([^\n]+)/i);
  const postureMatch = section.match(/posture[^:\n]*[:\-]\s*([^\n]+)/i);
  const chestMatch = section.match(/chest contraction[^:\n]*[:\-]\s*([^\n]+)/i);
  const headPitchMatch = section.match(/head pitch[^:\n]*[:\-]\s*([+\-]?\d+(?:\.\d+)?)/i);
  return {
    sessionId,
    participantId,
    timestamp: Date.now(),
    face: {
      landmarks: [],
      actionUnits,
      dominantExpression,
      confidence: coerceRatio(confidenceMatch?.[1], fallback.confidence),
      gaze: { x: stageAnchor.faceX, y: stageAnchor.faceY },
      headPose: {
        pitch: coerceSignedNumber(headPitchMatch?.[1], coerceSignedNumber(fallback.body.headPitch)),
        yaw: Number.parseFloat(((motionTrack.x - 0.5) * 22).toFixed(2)),
        roll: Number.parseFloat(((motionTrack.energy - 0.2) * 10).toFixed(2)),
      },
      browTension: clamp((actionUnits.AU01 ?? 0) * 0.6 + (actionUnits.AU02 ?? 0) * 0.4),
      eyeOpenness: clamp(1 - (actionUnits.AU07 ?? 0) * 0.5),
      mouthTension: clamp((actionUnits.AU14 ?? 0) * 0.4 + (actionUnits.AU17 ?? 0) * 0.5),
    },
      body: {
      posture: postureMatch?.[1]?.trim() ?? (personLine ? "Observed upper-body posture" : fallback.body.posture),
      openness: clamp(0.64 - motionTrack.energy * 0.2),
      tension: clamp(0.22 + motionTrack.energy * 0.48),
      gestureSignals: [
        { name: "chest_contraction", value: coerceRatio(chestMatch?.[1], 0.12) },
        { name: "head_pitch", value: clamp(Math.abs(coerceSignedNumber(headPitchMatch?.[1], 0)) / 15) },
        { name: "motion_energy", value: motionTrack.energy },
      ],
      torso: {
        contraction: coerceSignedNumber(chestMatch?.[1], Number.parseFloat(fallback.body.chestContraction)),
        lean: Number.parseFloat(((motionTrack.y - 0.5) * -20).toFixed(2)),
        rotation: Number.parseFloat(((motionTrack.x - 0.5) * 24).toFixed(2)),
      },
    },
      vocal: {
      affectiveTone: toneMatch?.[1]?.trim() ?? toneLabel(fallback.tone),
      energy: fallback.tone,
      pitch: 140 + motionTrack.energy * 45,
      speakingRate: 2.4 + motionTrack.energy * 1.2,
      tension: clamp(0.34 + motionTrack.energy * 0.46),
      confidence: coerceRatio(confidenceMatch?.[1], fallback.confidence),
      cadence: clamp(0.5 + motionTrack.energy * 0.34),
      shimmer: clamp(0.18 + motionTrack.energy * 0.22),
    },
  };
}

function parseRawOraclePatterns(section: string, fallback: PreviewMockState) {
  const lines = splitLines(section);
  const detectedPatternsLine = lines.find((line) => /^detected patterns:/i.test(line));
  const rawPatternItems = detectedPatternsLine
    ? detectedPatternsLine.replace(/^detected patterns:\s*/i, "").split(/\s*;\s*/)
    : lines.filter((line) => !/coherence|match|overall|fusion/i.test(line));

  return (rawPatternItems.length > 0 ? rawPatternItems : fallback.patterns.map((pattern) => pattern.name))
    .slice(0, 8)
    .map((line, index) => {
      const confidenceMatch = line.match(/avg confidence\s*(\d{1,3}(?:\.\d+)?)\s*%/i) ?? line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      const modalityMatch = line.match(/modalities:\s*([^)]+)/i);
      const cleanedName = line
        .replace(/\(.*$/, "")
        .replace(/^detected patterns:\s*/i, "")
        .replace(/_/g, " ")
        .trim();
      const confidence = coerceRatio(confidenceMatch?.[1], fallback.patterns[index]?.confidence ?? 0.72);

      return {
        name: cleanedName || fallback.patterns[index]?.name || `Pattern ${index + 1}`,
        modality: inferPatternModality(modalityMatch?.[1] ?? line),
        confidence,
        status: inferPatternStatus(confidence, line),
      } satisfies PreviewPattern;
    });
}

function normalizePatternStatus(value: string | undefined, fallback: PreviewPattern["status"] = "watch"): PreviewPattern["status"] {
  if (!value) {
    return fallback;
  }
  if (value === "aligned" || value === "watch" || value === "divergent") {
    return value;
  }
  return fallback;
}

function extractOracleRuleMatches(payload: OpmRawPayload): OracleRuleMatch[] {
  const source = payload.oracle_rt;
  if (!source || typeof source !== "object") {
    return [];
  }
  const matches = (source as Record<string, unknown>).cross_modal_rule_matches;
  if (!Array.isArray(matches)) {
    return [];
  }
  return matches
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      rule: String(item.rule ?? item.rule_name ?? "rule"),
      category: String(item.category ?? "cross_modal"),
      confidence: clamp(Number(item.confidence ?? 0.6)),
      modalities: Array.isArray(item.modalities) ? item.modalities.map((value) => String(value)) : [],
      status: normalizePatternStatus(typeof item.status === "string" ? item.status : undefined, "aligned"),
      explanation: typeof item.explanation === "string" ? item.explanation : undefined,
      signalsUsed:
        typeof item.signals_used === "object" && item.signals_used !== null
          ? (item.signals_used as Record<string, unknown>)
          : undefined,
      personId:
        typeof item.person_id === "number" || typeof item.person_id === "string"
          ? item.person_id
          : undefined,
      originalEmotion: typeof item.original_emotion === "string" ? item.original_emotion : undefined,
      correctedEmotion: typeof item.corrected_emotion === "string" ? item.corrected_emotion : undefined,
    }));
}

function extractOracleCorrectedEmotions(payload: OpmRawPayload): OracleCorrectedEmotion[] {
  const directSource =
    payload.oracle_rt && typeof payload.oracle_rt === "object"
      ? (payload.oracle_rt as Record<string, unknown>).corrected_emotions
      : undefined;
  const fallbackSource = payload.oracle_structured?.corrected_emotions;
  const source = Array.isArray(directSource) ? directSource : Array.isArray(fallbackSource) ? fallbackSource : [];

  return source
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      personId:
        typeof item.person_id === "number" || typeof item.person_id === "string"
          ? item.person_id
          : undefined,
      originalEmotion: String(item.original_emotion ?? "unknown"),
      correctedEmotion: String(item.corrected_emotion ?? "unknown"),
      ruleName: typeof item.rule_name === "string" ? item.rule_name : undefined,
      confidence: typeof item.confidence === "number" ? item.confidence : undefined,
      explanation: typeof item.explanation === "string" ? item.explanation : undefined,
    }));
}

function extractOracleSignalContext(payload: OpmRawPayload): Record<string, OracleSignalContext> {
  const source = payload.oracle_structured?.person_signal_context;
  if (!source || typeof source !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(source).map(([personId, value]) => {
      const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
      return [
        personId,
        {
          faceTop: typeof record.face_top === "string" ? record.face_top : null,
          textTop: typeof record.text_top === "string" ? record.text_top : null,
          voiceStability: typeof record.voice_stability === "number" ? record.voice_stability : null,
          hasSelfTouch: Boolean(record.has_self_touch),
          selfTouchCount: typeof record.self_touch_count === "number" ? record.self_touch_count : 0,
          hasTension: Boolean(record.has_tension),
          facsTop3: Array.isArray(record.facs_top3)
            ? record.facs_top3
                .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
                .map((item) => ({
                  pattern: String(item.pattern ?? "pattern"),
                  emotion: String(item.emotion ?? "emotion"),
                  confidence: clamp(Number(item.confidence ?? 0)),
                }))
            : [],
        } satisfies OracleSignalContext,
      ];
    }),
  );
}

function extractOracleFindings(payload: OpmRawPayload): OracleFinding[] {
  const source = payload.oracle_structured?.findings;
  if (!Array.isArray(source)) {
    return [];
  }
  return source
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      type: String(item.type ?? "finding"),
      ruleName: typeof item.rule_name === "string" ? item.rule_name : undefined,
      personId:
        typeof item.person_id === "number" || typeof item.person_id === "string"
          ? item.person_id
          : undefined,
      confidence: typeof item.confidence === "number" ? item.confidence : undefined,
      modalities: Array.isArray(item.modalities) ? item.modalities.map((value) => String(value)) : [],
      explanation: typeof item.explanation === "string" ? item.explanation : typeof item.detail === "string" ? item.detail : undefined,
      signalsUsed:
        typeof item.signals_used === "object" && item.signals_used !== null
          ? (item.signals_used as Record<string, unknown>)
          : undefined,
      originalFaceEmotion: typeof item.original_face_emotion === "string" ? item.original_face_emotion : undefined,
      relabeledEmotion: typeof item.relabeled_emotion === "string" ? item.relabeled_emotion : undefined,
      relabeledSubtype: typeof item.relabeled_subtype === "string" ? item.relabeled_subtype : undefined,
      detail: typeof item.detail === "string" ? item.detail : undefined,
    }));
}

function parseOracleSection(
  sessionId: string,
  participantId: string,
  section: string,
  fallback: PreviewMockState,
  motionTrack: MotionTrack,
): OracleOutput {
  const patterns = parseRawOraclePatterns(section, fallback);

  const semanticVsToneMatch = section.match(/semantic(?:\s+vs\s+tone)?[^0-9]*(\d{1,3}(?:\.\d+)?)\s*%?/i);
  const toneVsExpressionMatch = section.match(/tone(?:\s+vs\s+expression)?[^0-9]*(\d{1,3}(?:\.\d+)?)\s*%?/i);
  const expressionVsBodyMatch = section.match(/expression(?:\s+vs\s+body)?[^0-9]*(\d{1,3}(?:\.\d+)?)\s*%?/i);
  const overallMatch = section.match(/overall[^0-9]*(\d{1,3}(?:\.\d+)?)\s*%?/i);

  return {
    sessionId,
    participantId,
    timestamp: Date.now(),
    coherence: {
      semanticVsTone: coerceRatio(semanticVsToneMatch?.[1], clamp(0.7 - motionTrack.energy * 0.12)),
      toneVsExpression: coerceRatio(toneVsExpressionMatch?.[1], clamp(0.66 + fallback.tone * 0.2)),
      expressionVsBody: coerceRatio(expressionVsBodyMatch?.[1], clamp(0.62 + (1 - motionTrack.energy) * 0.22)),
      semanticVsBody: clamp(0.6 + fallback.confidence * 0.14 - motionTrack.energy * 0.1),
      overall: coerceRatio(overallMatch?.[1], clamp(0.66 + fallback.confidence * 0.16 - motionTrack.energy * 0.08)),
    },
    mismatches: patterns
      .filter((pattern) => pattern.status === "divergent")
      .slice(0, 2)
      .map((pattern) => ({
        type: pattern.modality === "body" ? "expression_body" : pattern.modality === "semantic" ? "semantic_tone" : "tone_expression",
        severity: pattern.confidence,
        note: pattern.name,
      })),
    patterns,
  };
}

function parseLucidSection(
  sessionId: string,
  participantId: string,
  section: string,
  fallback: PreviewMockState,
  motionLabel: string,
  bodyLabel: string,
): LucidOutput {
  const summaryBlockMatch = section.match(/\*\*State Summary:\*\*\s*([\s\S]*?)(?:\*\*Key Moments:\*\*|$)/i);
  const keyMomentsBlockMatch = section.match(/\*\*Key Moments:\*\*\s*([\s\S]*)/i);
  const keyMomentLines = splitLines(keyMomentsBlockMatch?.[1] ?? "").filter(Boolean);
  const summaryLines = splitLines(summaryBlockMatch?.[1] ?? "");
  const stateSummary = summaryLines.join(" ").replace(/\s+/g, " ").trim() || fallback.summary;

  return {
    sessionId,
    participantId,
    timestamp: Date.now(),
    stateSummary,
    intentSummary: `Session remains centered on ${fallback.expression.toLowerCase()}.`,
    reasonTrace: [
      stateSummary,
      motionLabel,
      bodyLabel,
    ],
    keyMoments: (keyMomentLines.length > 0
      ? keyMomentLines
      : fallback.trace.map((item) => `${item.timestamp} ${item.event}`))
      .slice(0, 6)
      .map((line, index) => {
        const timestampMatch = line.match(/(\d{2}:\d{2})/);
        const event = line.replace(/^\d{2}:\d{2}\s*/, "").replace(/^[\-\*\u2022]\s*/, "").trim();
        return {
          timestamp: timestampMatch?.[1] ?? fallback.trace[index]?.timestamp ?? `00:${String(index).padStart(2, "0")}`,
          event: event || fallback.trace[index]?.event || `Moment ${index + 1}`,
          reason: event || fallback.trace[index]?.event || `Moment ${index + 1}`,
        };
      }),
    relay: {
      ttsPrompt: stateSummary,
      avatarInstruction: "Maintain engaged posture and responsive eye-line.",
      priority: "normal",
    },
  };
}

function parseRawPayload(
  payload: OpmRawPayload,
  sessionId: string,
  participantId: string,
  fallback: PreviewMockState,
  motionTrack: MotionTrack,
  stageAnchor: StageAnchor,
  motionLabel: string,
  bodyLabel: string,
): ParsedPerception | null {
  const cygnusSection = normalizeWhitespace(payload.cygnus ?? "");
  const oracleSection = normalizeWhitespace(payload.oracle ?? "");
  const lucidSection = normalizeWhitespace(payload.lucid ?? "");
  const oracleRtSection = typeof payload.oracle_rt === "string" ? normalizeWhitespace(payload.oracle_rt) : "";

  if (!cygnusSection && !oracleSection && !lucidSection && !oracleRtSection) {
    return null;
  }

  const lucidBlocks = parseLucidBlocks(lucidSection);
  const coherenceBlock = lucidBlocks["coherence assessment"] ?? "";
  const confidenceBlock = lucidBlocks["confidence rating"] ?? "";
  const patternsBlock = lucidBlocks.patterns ?? "";
  const keyMomentsBlock = lucidBlocks["key moments"] ?? "";
  const stateSummaryBlock = lucidBlocks["state summary"] ?? "";

  const cygnus = parseCygnusSection(sessionId, participantId, cygnusSection, fallback, motionTrack, stageAnchor);
  const oracle = parseOracleSection(
    sessionId,
    participantId,
    [oracleSection, patternsBlock, coherenceBlock, confidenceBlock].filter(Boolean).join("\n"),
    fallback,
    motionTrack,
  );
  const ruleMatches = extractOracleRuleMatches(payload);
  const correctedEmotions = extractOracleCorrectedEmotions(payload);
  const signalContext = extractOracleSignalContext(payload);
  const findings = extractOracleFindings(payload);
  const structuredPatterns: PreviewPattern[] = ruleMatches.map((match) => ({
    name: match.rule.replace(/_/g, " "),
    modality: inferPatternModality(match.modalities.join(" ") || match.category || match.rule),
    confidence: clamp(match.confidence),
    status: normalizePatternStatus(typeof match.status === "string" ? match.status : undefined, "aligned"),
  }));
  if (structuredPatterns.length > 0) {
    oracle.patterns = structuredPatterns;
  }
  oracle.ruleMatches = ruleMatches;
  oracle.correctedEmotions = correctedEmotions;
  oracle.signalContext = signalContext;
  oracle.findings = findings;
  oracle.coherenceStates = Array.isArray(payload.oracle_structured?.coherence_states)
    ? payload.oracle_structured?.coherence_states.map((value) => String(value))
    : [];
  const lucid = parseLucidSection(
    sessionId,
    participantId,
    [
      stateSummaryBlock ? `**State Summary:**\n${stateSummaryBlock}` : "",
      keyMomentsBlock ? `**Key Moments:**\n${keyMomentsBlock}` : "",
      coherenceBlock ? `**Coherence Assessment:**\n${coherenceBlock}` : "",
      confidenceBlock ? `**Confidence Rating:**\n${confidenceBlock}` : "",
      oracleRtSection ? `**Oracle RT:**\n${oracleRtSection}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    fallback,
    motionLabel,
    bodyLabel,
  );

  lucid.reasonTrace = [
    ...lucid.reasonTrace,
    ...(coherenceBlock ? [coherenceBlock] : []),
    ...(confidenceBlock ? [confidenceBlock] : []),
    ...(oracleRtSection ? [oracleRtSection] : []),
  ].slice(0, 6);

  if (stateSummaryBlock) {
    lucid.stateSummary = stateSummaryBlock.replace(/\s+/g, " ").trim();
    lucid.relay.ttsPrompt = lucid.stateSummary;
  }

  if (keyMomentsBlock) {
    lucid.keyMoments = splitLines(keyMomentsBlock)
      .slice(0, 6)
      .map((line, index) => {
        const timestampMatch = line.match(/(\d+(?:\.\d+)?s|~\d+(?:\.\d+)?s|\d{2}:\d{2})/i);
        const cleaned = line.replace(/^[\-\*\u2022]\s*/, "").trim();
        return {
          timestamp:
            timestampMatch?.[1]?.replace(/^~/, "")
            ?? fallback.trace[index]?.timestamp
            ?? `00:${String(index).padStart(2, "0")}`,
          event: cleaned.replace(/\*\*/g, ""),
          reason: cleaned.replace(/\*\*/g, ""),
        };
      });
  }

  if (payload.frame_count || payload.analysis_window_seconds) {
    const windowSummary = [
      payload.frame_count ? `${payload.frame_count} frame${payload.frame_count === 1 ? "" : "s"}` : "",
      payload.analysis_window_seconds ? `${payload.analysis_window_seconds}s window` : "",
    ]
      .filter(Boolean)
      .join(" across ");
    if (windowSummary) {
      lucid.reasonTrace = [windowSummary, ...lucid.reasonTrace].slice(0, 6);
    }
  }

  return {
    cygnus,
    oracle,
    lucid,
    latencyMs: payload.latency_ms,
  };
}

export class PreviewAnalysisAdapter {
  private endpointSessionId: string | null = null;
  private pollTimer: number | null = null;
  private latestRemote: ParsedPerception | null = null;
  private lastPollError: string | null = null;
  private isPolling = false;

  constructor(private options: PreviewAnalysisAdapterOptions) {}

  setEndpointSession(sessionId: string | null) {
    const normalized = sessionId?.trim() || null;
    if (this.endpointSessionId === normalized) {
      return;
    }
    this.endpointSessionId = normalized;
    this.latestRemote = null;
    this.lastPollError = null;
    this.stopPolling();
    if (normalized) {
      this.startPolling();
    }
  }

  destroy() {
    this.stopPolling();
  }

  getDataSource(): PreviewDataSource {
    return this.latestRemote ? "LIVE OPM" : "FALLBACK MOCK";
  }

  getEndpointSessionId() {
    return this.endpointSessionId;
  }

  publishFrame(input: PublishFrameInput) {
    if (this.latestRemote) {
      this.publishRemoteFrame(input, this.latestRemote);
      return;
    }
    this.publishMockFrame(input);
  }

  private async pollOnce() {
    if (!this.endpointSessionId || this.isPolling) {
      return;
    }

    this.isPolling = true;
    try {
      const response = await fetch(
        `https://anima.onioko.com/api/tools/opm-raw?session_id=${encodeURIComponent(this.endpointSessionId)}`,
      );
      if (!response.ok) {
        throw new Error(`Endpoint returned ${response.status}`);
      }

      const json = (await response.json()) as unknown;
      const rawPayload = extractRawPayload(json);
      if (!rawPayload) {
        this.latestRemote = null;
        this.lastPollError = null;
        return;
      }

      const fallback = buildPreviewState(Math.floor(Date.now() / 2400));
      const parsed = parseRawPayload(
        rawPayload,
        this.options.sessionId,
        this.options.participantId,
        fallback,
        { x: 0.5, y: 0.46, energy: 0.12 },
        { faceX: 0.5, faceY: 0.38 },
        "Endpoint-linked motion context",
        "Endpoint-linked body context",
      );

      this.latestRemote = parsed;
      this.lastPollError = null;
    } catch (error) {
      this.latestRemote = null;
      this.lastPollError = error instanceof Error ? error.message : "Endpoint polling failed";
      this.options.bus.publish("trace", {
        sessionId: this.options.sessionId,
        timestamp: Date.now(),
        stage: "oracle",
        level: "warn",
        message: this.lastPollError,
        participantId: this.options.participantId,
      });
    } finally {
      this.isPolling = false;
    }
  }

  private startPolling() {
    void this.pollOnce();
    this.pollTimer = window.setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling() {
    if (this.pollTimer) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private publishRemoteFrame(input: PublishFrameInput, remote: ParsedPerception) {
    const timestamp = Date.now();
    this.options.bus.publish("capture", {
      sessionId: this.options.sessionId,
      participantId: this.options.participantId,
      participantRole: "speaker_a",
      source: "local",
      timestamp,
      video: {
        width: input.videoWidth || 1280,
        height: input.videoHeight || 720,
        frameRate: 30,
        facingMode: "user",
      },
      audio: {
        sampleRate: 48000,
        channelCount: 1,
      },
    });

    this.options.bus.publish("cygnus", {
      ...remote.cygnus,
      timestamp,
    });
    this.options.bus.publish("oracle", {
      ...remote.oracle,
      timestamp,
    });
    this.options.bus.publish("lucid", {
      ...remote.lucid,
      timestamp,
    });
    this.options.bus.publish("transport", {
      sessionId: this.options.sessionId,
      timestamp,
      status: input.cameraReady ? "live" : input.cameraLoading ? "connecting" : input.cameraError ? "error" : "idle",
      localVideo: input.cameraReady,
      localAudio: false,
      remoteVideo: Boolean(this.endpointSessionId),
      remoteAudio: Boolean(this.endpointSessionId),
      latencyMs: remote.latencyMs ?? input.mockState.latency,
    });
    this.options.bus.publish("trace", {
      sessionId: this.options.sessionId,
      timestamp,
      stage: "oracle",
      level: "info",
      message: `Live OPM endpoint data mapped from session ${this.endpointSessionId}.`,
      latencyMs: remote.latencyMs ?? input.mockState.latency,
      participantId: this.options.participantId,
    });
  }

  private publishMockFrame(input: PublishFrameInput) {
    const { bus, participantId, sessionId } = this.options;
    const {
      mockState,
      motionTrack,
      stageAnchor,
      cameraReady,
      cameraLoading,
      cameraError,
      videoWidth,
      videoHeight,
      motionLabel,
      bodyLabel,
    } = input;
    const timestamp = Date.now();
    const affectiveTone = toneLabel(mockState.tone);

    bus.publish("capture", {
      sessionId,
      participantId,
      participantRole: "speaker_a",
      source: "local",
      timestamp,
      video: {
        width: videoWidth || 1280,
        height: videoHeight || 720,
        frameRate: 30,
        facingMode: "user",
      },
      audio: {
        sampleRate: 48000,
        channelCount: 1,
      },
    });

    bus.publish("cygnus", {
      sessionId,
      participantId,
      timestamp,
      face: {
        landmarks: [],
        actionUnits: mockState.actionUnits,
        dominantExpression: mockState.expression,
        confidence: mockState.confidence,
        gaze: { x: stageAnchor.faceX, y: stageAnchor.faceY },
        headPose: {
          pitch: Number.parseFloat(mockState.body.headPitch),
          yaw: Number.parseFloat(((motionTrack.x - 0.5) * 22).toFixed(2)),
          roll: Number.parseFloat(((motionTrack.energy - 0.2) * 10).toFixed(2)),
        },
        browTension: clamp(mockState.tone * 0.72 + motionTrack.energy * 0.3),
        eyeOpenness: clamp(0.62 - motionTrack.energy * 0.18),
        mouthTension: clamp(0.3 + motionTrack.energy * 0.38),
      },
      body: {
        posture: mockState.body.posture,
        openness: clamp(0.68 - motionTrack.energy * 0.24),
        tension: clamp(0.22 + motionTrack.energy * 0.58),
        gestureSignals: [
          { name: "chest_contraction", value: Number.parseFloat(mockState.body.chestContraction) / 10 },
          { name: "head_pitch", value: Number.parseFloat(mockState.body.headPitch) / 10 },
          { name: "motion_energy", value: motionTrack.energy },
        ],
        torso: {
          contraction: Number.parseFloat(mockState.body.chestContraction),
          lean: Number.parseFloat(((motionTrack.y - 0.5) * -20).toFixed(2)),
          rotation: Number.parseFloat(((motionTrack.x - 0.5) * 24).toFixed(2)),
        },
      },
      vocal: {
        affectiveTone,
        energy: mockState.tone,
        pitch: 140 + motionTrack.energy * 45,
        speakingRate: 2.4 + motionTrack.energy * 1.2,
        tension: clamp(0.34 + motionTrack.energy * 0.46),
        confidence: clamp(0.7 + mockState.confidence * 0.22),
        cadence: clamp(0.5 + motionTrack.energy * 0.34),
        shimmer: clamp(0.18 + motionTrack.energy * 0.22),
      },
    });

    bus.publish("oracle", {
      sessionId,
      participantId,
      timestamp,
      coherence: {
        semanticVsTone: clamp(0.7 + mockState.confidence * 0.2 - motionTrack.energy * 0.12),
        toneVsExpression: clamp(0.66 + mockState.tone * 0.2),
        expressionVsBody: clamp(0.62 + (1 - motionTrack.energy) * 0.22),
        semanticVsBody: clamp(0.6 + mockState.confidence * 0.14 - motionTrack.energy * 0.1),
        overall: clamp(0.66 + mockState.confidence * 0.16 - motionTrack.energy * 0.08),
      },
      mismatches: motionTrack.energy > 0.28
        ? [
            {
              type: "expression_body",
              severity: clamp(0.42 + motionTrack.energy * 0.4),
              note: "Body drift rises faster than visible facial stabilization.",
            },
          ]
        : [],
      patterns: mockState.patterns,
    });

    bus.publish("lucid", {
      sessionId,
      participantId,
      timestamp,
      stateSummary: mockState.summary,
      intentSummary: `Session remains centered on ${mockState.expression.toLowerCase()}.`,
      reasonTrace: [
        `${affectiveTone} detected from vocal envelope.`,
        `${mockState.patterns[0]?.name ?? "Cross-modal sync"} remains primary live lock.`,
        `${motionLabel} and ${bodyLabel.toLowerCase()}.`,
      ],
      keyMoments: mockState.trace.map((item) => ({
        timestamp: item.timestamp,
        event: item.event,
        reason: item.event,
      })),
      relay: {
        ttsPrompt: mockState.summary,
        avatarInstruction: "Maintain engaged posture and responsive eye-line.",
        priority: motionTrack.energy > 0.28 ? "high" : "normal",
      },
    });

    bus.publish("transport", {
      sessionId,
      timestamp,
      status: cameraReady ? "live" : cameraLoading ? "connecting" : cameraError ? "error" : "idle",
      localVideo: cameraReady,
      localAudio: false,
      remoteVideo: false,
      remoteAudio: false,
      latencyMs: mockState.latency,
    });

    bus.publish("trace", {
      sessionId,
      timestamp,
      stage: "transport",
      level: cameraError ? "warn" : "info",
      message:
        this.lastPollError && this.endpointSessionId
          ? `Endpoint fallback active: ${this.lastPollError}`
          : cameraReady
            ? "Local capture live on preview session bus."
            : (cameraError ?? "Waiting for local capture."),
      latencyMs: mockState.latency,
      participantId,
    });
  }
}

export function createPreviewAnalysisAdapter(options: PreviewAnalysisAdapterOptions) {
  return new PreviewAnalysisAdapter(options);
}
