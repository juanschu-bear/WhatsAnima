import type { PerceptionSessionBus } from "../lib/sessionBus";

export type MotionTrack = {
  x: number;
  y: number;
  energy: number;
};

export type CaptureAdapterSnapshot = {
  cameraReady: boolean;
  cameraLoading: boolean;
  cameraError: string | null;
  motionTrack: MotionTrack;
};

type CaptureAdapterListener = (snapshot: CaptureAdapterSnapshot) => void;

type CaptureAdapterOptions = {
  sessionId: string;
  participantId: string;
  bus: PerceptionSessionBus;
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function formatCameraError(error: unknown) {
  if (!(error instanceof Error)) {
    return "Kamera konnte nicht gestartet werden. Bitte erneut anfragen.";
  }

  const message = error.message.toLowerCase();

  if (message.includes("dismiss")) {
    return "Kamera-Anfrage wurde geschlossen. Klicke auf 'Kamera verbinden'.";
  }

  if (message.includes("denied") || message.includes("permission")) {
    return "Kamera-Zugriff wurde blockiert. Erlaube ihn im Browser und frage ihn dann erneut an.";
  }

  return error.message;
}

export class CaptureAdapter {
  private videoElement: HTMLVideoElement | null = null;
  private analysisCanvas: HTMLCanvasElement | null = null;
  private stream: MediaStream | null = null;
  private previousFrame: Uint8Array | null = null;
  private frameId = 0;
  private lastEmit = 0;
  private listeners = new Set<CaptureAdapterListener>();
  private snapshot: CaptureAdapterSnapshot = {
    cameraReady: false,
    cameraLoading: false,
    cameraError: null,
    motionTrack: { x: 0.5, y: 0.46, energy: 0 },
  };

  constructor(private options: CaptureAdapterOptions) {}

  subscribe(listener: CaptureAdapterListener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  attachVideoElement(element: HTMLVideoElement | null) {
    this.videoElement = element;
    if (element && this.stream) {
      element.srcObject = this.stream;
      void element.play().catch(() => undefined);
    }
  }

  attachAnalysisCanvas(element: HTMLCanvasElement | null) {
    this.analysisCanvas = element;
  }

  async start() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.updateSnapshot({
        cameraReady: false,
        cameraLoading: false,
        cameraError: "Dieser Browser unterstuetzt keinen Kamera-Zugriff.",
      });
      return;
    }

    this.updateSnapshot({
      cameraLoading: true,
      cameraError: null,
    });
    this.stop({ silent: true });
    this.updateSnapshot({ cameraLoading: true, cameraError: null });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      this.stream = stream;
      if (this.videoElement) {
        this.videoElement.srcObject = stream;
        void this.videoElement.play().catch(() => undefined);
      }

      this.updateSnapshot({
        cameraReady: true,
        cameraLoading: false,
        cameraError: null,
      });

      this.publishTransport("live");
      this.publishCapture();
      this.startMotionLoop();
    } catch (error) {
      const message = formatCameraError(error);
      this.updateSnapshot({
        cameraReady: false,
        cameraLoading: false,
        cameraError: message,
      });
      this.options.bus.publish("transport", {
        sessionId: this.options.sessionId,
        timestamp: Date.now(),
        status: "error",
        localVideo: false,
        localAudio: false,
        remoteVideo: false,
        remoteAudio: false,
      });
      this.options.bus.publish("trace", {
        sessionId: this.options.sessionId,
        timestamp: Date.now(),
        stage: "capture",
        level: "warn",
        message,
        participantId: this.options.participantId,
      });
    }
  }

  stop(options?: { silent?: boolean }) {
    if (this.frameId) {
      window.cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.previousFrame = null;

    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.srcObject = null;
    }

    this.updateSnapshot({
      cameraReady: false,
      cameraLoading: false,
      cameraError: options?.silent ? null : "Kamera ist aktuell aus.",
      motionTrack: { x: 0.5, y: 0.46, energy: 0 },
    });

    this.publishTransport("idle");
    if (!options?.silent) {
      this.options.bus.publish("trace", {
        sessionId: this.options.sessionId,
        timestamp: Date.now(),
        stage: "capture",
        level: "info",
        message: "Local camera capture stopped.",
        participantId: this.options.participantId,
      });
    }
  }

  destroy() {
    this.stop({ silent: true });
    this.listeners.clear();
  }

  private updateSnapshot(patch: Partial<CaptureAdapterSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      motionTrack: patch.motionTrack ?? this.snapshot.motionTrack,
    };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private publishCapture() {
    this.options.bus.publish("capture", {
      sessionId: this.options.sessionId,
      participantId: this.options.participantId,
      participantRole: "speaker_a",
      source: "local",
      timestamp: Date.now(),
      video: {
        width: this.videoElement?.videoWidth || 1280,
        height: this.videoElement?.videoHeight || 720,
        frameRate: 30,
        facingMode: "user",
      },
      audio: {
        sampleRate: 48000,
        channelCount: 1,
      },
    });
  }

  private publishTransport(status: "idle" | "live" | "connecting" | "error") {
    this.options.bus.publish("transport", {
      sessionId: this.options.sessionId,
      timestamp: Date.now(),
      status,
      localVideo: status === "live",
      localAudio: false,
      remoteVideo: false,
      remoteAudio: false,
    });
  }

  private startMotionLoop() {
    if (!this.videoElement) {
      return;
    }

    const canvas = this.analysisCanvas;
    const context = canvas?.getContext("2d", { willReadFrequently: true });

    if (!canvas || !context) {
      return;
    }

    const sampleWidth = 160;
    const sampleHeight = 90;
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;

    const scanMotion = () => {
      if (!this.videoElement || !this.stream) {
        return;
      }

      if (this.videoElement.readyState >= 2) {
        context.drawImage(this.videoElement, 0, 0, sampleWidth, sampleHeight);
        const frame = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
        const gray = new Uint8Array(sampleWidth * sampleHeight);
        let changed = 0;
        let sumX = 0;
        let sumY = 0;

        for (let y = 0; y < sampleHeight; y += 2) {
          for (let x = 0; x < sampleWidth; x += 2) {
            const index = y * sampleWidth + x;
            const pixelIndex = index * 4;
            const value = Math.round(
              frame[pixelIndex] * 0.299 +
              frame[pixelIndex + 1] * 0.587 +
              frame[pixelIndex + 2] * 0.114,
            );
            gray[index] = value;

            if (this.previousFrame && Math.abs(value - this.previousFrame[index]) > 24) {
              changed += 1;
              sumX += x;
              sumY += y;
            }
          }
        }

        this.previousFrame = gray;

        const now = performance.now();
        if (now - this.lastEmit > 80) {
          this.lastEmit = now;
          if (changed > 12) {
            const nextX = 1 - sumX / changed / (sampleWidth - 1);
            const nextY = sumY / changed / (sampleHeight - 1);
            const nextEnergy = clamp(changed / 380, 0, 1);
            this.updateSnapshot({
              motionTrack: {
                x: this.snapshot.motionTrack.x * 0.78 + nextX * 0.22,
                y: this.snapshot.motionTrack.y * 0.78 + nextY * 0.22,
                energy: this.snapshot.motionTrack.energy * 0.66 + nextEnergy * 0.34,
              },
            });
            this.publishCapture();
          } else {
            this.updateSnapshot({
              motionTrack: {
                ...this.snapshot.motionTrack,
                energy: this.snapshot.motionTrack.energy * 0.82,
              },
            });
          }
        }
      }

      this.frameId = window.requestAnimationFrame(scanMotion);
    };

    this.frameId = window.requestAnimationFrame(scanMotion);
  }
}

export function createCaptureAdapter(options: CaptureAdapterOptions) {
  return new CaptureAdapter(options);
}
