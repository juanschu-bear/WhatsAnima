import type { RefObject } from 'react'

interface StageState {
  emoji: string
  text: string
  progress: number
}

interface VideoRecorderProps {
  open: boolean
  recordingMode: 'idle' | 'recording' | 'stopping'
  recordingSeconds: number
  previewUrl: string | null
  previewDuration: number
  processingStage: StageState | null
  liveVideoRef: RefObject<HTMLVideoElement | null>
  previewVideoRef: RefObject<HTMLVideoElement | null>
  onClose: () => void
  onStartRecording: () => Promise<void>
  onStopRecording: () => Promise<void>
  onRetake: () => Promise<void>
  onSend: () => Promise<void>
  sending: boolean
}

function formatClock(totalSeconds: number) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = Math.floor(safeSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function VideoRecorder({
  open,
  recordingMode,
  recordingSeconds,
  previewUrl,
  previewDuration,
  processingStage,
  liveVideoRef,
  previewVideoRef,
  onClose,
  onStartRecording,
  onStopRecording,
  onRetake,
  onSend,
  sending,
}: VideoRecorderProps) {
  if (!open) return null

  const hasPreview = Boolean(previewUrl)

  return (
    <div className="absolute inset-0 z-30 flex items-end bg-[#02060dd9] p-4 sm:items-center sm:justify-center">
      <div className="w-full max-w-md rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,44,0.96),rgba(10,20,33,0.98))] p-5 shadow-[0_28px_100px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Video message</h2>
          <button type="button" onClick={onClose} className="text-sm text-white/60">Cancel</button>
        </div>

        <div className="mt-4 overflow-hidden rounded-[24px] border border-white/10 bg-black/30">
          {hasPreview ? (
            <video
              ref={previewVideoRef}
              className="aspect-square w-full object-cover"
              controls
              playsInline
              preload="metadata"
            />
          ) : (
            <video
              ref={liveVideoRef}
              className="aspect-square w-full object-cover"
              muted
              playsInline
              autoPlay
            />
          )}
        </div>

        <div className="mt-3 flex items-center justify-between text-sm text-white/70">
          <span>
            {hasPreview
              ? `Preview ${formatClock(previewDuration)}`
              : recordingMode === 'recording'
                ? 'Recording...'
                : 'Tap record to start'}
          </span>
          <span className="font-medium">{formatClock(hasPreview ? previewDuration : recordingSeconds)}</span>
        </div>

        {processingStage ? (
          <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80">
            <div className="inline-processing-stage">
              <span>{processingStage.emoji}</span>
              <span>{processingStage.text}</span>
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-3">
          {!hasPreview ? (
            recordingMode === 'recording' ? (
              <button
                type="button"
                onClick={() => void onStopRecording()}
                className="flex-1 rounded-full bg-gradient-to-r from-[#ff6b7f] to-[#e63d62] px-4 py-3 text-sm font-semibold text-white"
              >
                Stop recording
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void onStartRecording()}
                className="flex-1 rounded-full bg-gradient-to-r from-[#11c2a0] to-[#38a9ff] px-4 py-3 text-sm font-semibold text-white"
              >
                Record video
              </button>
            )
          ) : (
            <>
              <button
                type="button"
                onClick={() => void onRetake()}
                disabled={sending}
                className="flex-1 rounded-full border border-white/10 px-4 py-3 text-sm font-semibold text-white/80 disabled:opacity-40"
              >
                Retake
              </button>
              <button
                type="button"
                onClick={() => void onSend()}
                disabled={sending}
                className="flex-1 rounded-full bg-gradient-to-r from-[#11c2a0] to-[#38a9ff] px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                Send
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
