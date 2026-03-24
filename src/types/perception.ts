export type ParticipantSource = "local" | "remote";

export type ParticipantRole = "speaker_a" | "speaker_b" | "observer" | "avatar";

export type PatternModality =
  | "cross_modal"
  | "face_au"
  | "vocal"
  | "semantic"
  | "body";

export type PatternStatus = "aligned" | "watch" | "divergent";

export type DeliveryTarget =
  | "tts"
  | "avatar"
  | "call_response"
  | "session_log"
  | "analytics";

export type DeliveryPriority = "low" | "normal" | "high";

export type SessionTransportStatus =
  | "idle"
  | "connecting"
  | "live"
  | "degraded"
  | "disconnected"
  | "error";

export type LandmarkPoint2D = {
  x: number;
  y: number;
};

export type LandmarkPoint3D = LandmarkPoint2D & {
  z?: number;
};

export type SignalValue = {
  name: string;
  value: number;
  confidence?: number;
};

export type CaptureVideoDescriptor = {
  width?: number;
  height?: number;
  frameRate?: number;
  facingMode?: string;
};

export type CaptureAudioDescriptor = {
  sampleRate?: number;
  channelCount?: number;
};

export type CaptureFrame = {
  sessionId: string;
  participantId: string;
  participantRole: ParticipantRole;
  source: ParticipantSource;
  timestamp: number;
  videoFrame?: VideoFrame | ImageBitmap | null;
  audioChunk?: Float32Array | null;
  video?: CaptureVideoDescriptor;
  audio?: CaptureAudioDescriptor;
};

export type TranscriptChunk = {
  sessionId: string;
  participantId: string;
  timestamp: number;
  text: string;
  language?: string;
  confidence?: number;
  isFinal?: boolean;
};

export type FaceSignals = {
  landmarks: LandmarkPoint3D[];
  actionUnits: Record<string, number>;
  dominantExpression: string;
  confidence: number;
  gaze?: LandmarkPoint2D;
  headPose?: {
    pitch: number;
    yaw: number;
    roll: number;
  };
  browTension?: number;
  eyeOpenness?: number;
  mouthTension?: number;
};

export type BodySignals = {
  posture: string;
  openness: number;
  tension: number;
  gestureSignals: SignalValue[];
  joints?: Record<string, LandmarkPoint2D>;
  torso?: {
    contraction: number;
    lean: number;
    rotation: number;
  };
};

export type VocalSignals = {
  affectiveTone: string;
  energy: number;
  pitch: number;
  speakingRate: number;
  tension: number;
  confidence: number;
  cadence?: number;
  shimmer?: number;
};

export type CygnusOutput = {
  sessionId: string;
  participantId: string;
  timestamp: number;
  face: FaceSignals;
  body: BodySignals;
  vocal: VocalSignals;
};

export type OracleMismatch = {
  type: "semantic_tone" | "tone_expression" | "expression_body" | "semantic_body";
  severity: number;
  note: string;
};

export type OraclePattern = {
  name: string;
  modality: PatternModality;
  confidence: number;
  status: PatternStatus;
};

export type OracleRuleMatch = {
  rule: string;
  category: string;
  confidence: number;
  modalities: string[];
  status: PatternStatus | string;
  explanation?: string;
  signalsUsed?: Record<string, unknown>;
  personId?: number | string;
  originalEmotion?: string;
  correctedEmotion?: string;
};

export type OracleCorrectedEmotion = {
  personId?: number | string;
  originalEmotion: string;
  correctedEmotion: string;
  ruleName?: string;
  confidence?: number;
  explanation?: string;
};

export type OracleFinding = {
  type: string;
  ruleName?: string;
  personId?: number | string;
  confidence?: number;
  modalities?: string[];
  explanation?: string;
  signalsUsed?: Record<string, unknown>;
  originalFaceEmotion?: string;
  relabeledEmotion?: string;
  relabeledSubtype?: string;
  detail?: string;
};

export type OracleSignalContext = {
  faceTop?: string | null;
  textTop?: string | null;
  voiceStability?: number | null;
  hasSelfTouch?: boolean;
  selfTouchCount?: number;
  hasTension?: boolean;
  facsTop3?: Array<{
    pattern: string;
    emotion: string;
    confidence: number;
  }>;
};

export type OracleOutput = {
  sessionId: string;
  participantId: string;
  timestamp: number;
  coherence: {
    semanticVsTone: number;
    toneVsExpression: number;
    expressionVsBody: number;
    semanticVsBody: number;
    overall: number;
  };
  mismatches: OracleMismatch[];
  patterns: OraclePattern[];
  ruleMatches?: OracleRuleMatch[];
  correctedEmotions?: OracleCorrectedEmotion[];
  signalContext?: Record<string, OracleSignalContext>;
  findings?: OracleFinding[];
  coherenceStates?: string[];
};

export type LucidKeyMoment = {
  timestamp: string;
  event: string;
  reason: string;
};

export type LucidOutput = {
  sessionId: string;
  participantId: string;
  timestamp: number;
  stateSummary: string;
  intentSummary?: string;
  reasonTrace: string[];
  keyMoments: LucidKeyMoment[];
  relay: {
    ttsPrompt?: string;
    avatarInstruction?: string;
    priority: DeliveryPriority;
  };
};

export type DeliveryPacket = {
  sessionId: string;
  participantId: string;
  timestamp: number;
  target: DeliveryTarget;
  text?: string;
  audioInstruction?: string;
  avatarInstruction?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type TraceEvent = {
  sessionId: string;
  timestamp: number;
  stage: "capture" | "cygnus" | "oracle" | "lucid" | "delivery" | "transport";
  level: "info" | "warn" | "error";
  message: string;
  latencyMs?: number;
  participantId?: string;
};

export type TransportState = {
  sessionId: string;
  timestamp: number;
  status: SessionTransportStatus;
  localVideo: boolean;
  localAudio: boolean;
  remoteVideo: boolean;
  remoteAudio: boolean;
  latencyMs?: number;
};

export type PerceptionEventMap = {
  capture: CaptureFrame;
  transcript: TranscriptChunk;
  cygnus: CygnusOutput;
  oracle: OracleOutput;
  lucid: LucidOutput;
  delivery: DeliveryPacket;
  trace: TraceEvent;
  transport: TransportState;
};

export type PerceptionEventType = keyof PerceptionEventMap;

export type PerceptionEvent<TType extends PerceptionEventType = PerceptionEventType> = {
  type: TType;
  payload: PerceptionEventMap[TType];
};

export type PerceptionSnapshot = {
  capture?: CaptureFrame;
  transcript?: TranscriptChunk;
  cygnus?: CygnusOutput;
  oracle?: OracleOutput;
  lucid?: LucidOutput;
  delivery?: DeliveryPacket;
  trace?: TraceEvent;
  transport?: TransportState;
};
