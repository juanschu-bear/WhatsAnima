import { useEffect } from 'react'
import { useVideoRecording } from '../hooks/useVideoRecording'

function formatClock(totalSeconds: number) {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

interface VideoRecorderProps {
  open: boolean
  onClose: () => void
  onSend: (payload: {
    blob: Blob
    durationSec: number
    orientation: 'portrait' | 'landscape'
    width: number
    height: number
  }) => Promise<void> | void
}

export function VideoRecorder({ open, onClose, onSend }: VideoRecorderProps) {
  const recorder = useVideoRecording({ onConfirmSend: onSend })

  useEffect(() => {
    if (!open) return
    void recorder.startCamera()
    return () => recorder.cancel()
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!recorder.error) return
    console.error('[VideoRecorder]', recorder.error)
  }, [open, recorder.error])

  if (!open) return null

  const remaining = Math.max(0, recorder.maxDurationSec - recorder.duration)

  return (
    <div className="absolute inset-0 z-30 h-screen overflow-hidden bg-black">
      <div className="flex min-h-screen flex-col overflow-hidden px-4 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-[calc(env(safe-area-inset-top)+16px)]">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              recorder.cancel()
              onClose()
            }}
            className="rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white"
          >
            Close
          </button>
          <div className={`text-lg font-semibold tabular-nums ${remaining <= 30 ? 'text-[#ff7b7b]' : 'text-white'}`}>
            {formatClock(recorder.duration)}
          </div>
          <div className="text-xs text-white/55">{formatClock(remaining)} left</div>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-hidden py-4">
          <div className="relative h-[min(46vh,360px)] w-[min(88vw,420px)] max-w-full overflow-hidden rounded-[32px] border border-white/12 bg-[#0e1722] shadow-[0_30px_90px_rgba(0,0,0,0.45)]">
            {recorder.isPreviewing && recorder.previewUrl ? (
              <video
                ref={recorder.previewVideoRef}
                src={recorder.previewUrl}
                controls
                autoPlay
                muted
                playsInline
                className="h-full w-full object-cover"
              />
            ) : (
              <video
                ref={recorder.liveVideoRef}
                autoPlay
                muted
                playsInline
                className="-scale-x-100 h-full w-full object-cover"
              />
            )}
            <div className="pointer-events-none absolute inset-0">
              <div
                className="absolute left-1/2 rounded-[999px] border border-white/35 shadow-[0_0_0_9999px_rgba(0,0,0,0.16)]"
                style={{
                  top: '42%',
                  width: 'min(60vw, 250px)',
                  height: 'min(72vw, 300px)',
                  transform: 'translate(-50%, -50%)',
                }}
              />
            </div>
            {recorder.permissionPending ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                <span className="rounded-full bg-black/45 px-4 py-2 text-sm text-white">Waiting for camera permission...</span>
              </div>
            ) : null}
          </div>

          <div className={`max-w-[min(88vw,420px)] rounded-full px-4 py-2 text-center text-sm font-medium ${
            recorder.guidanceTone === 'warning'
              ? 'bg-[#4f3600] text-[#ffd25a]'
              : recorder.guidanceTone === 'success'
                ? 'bg-[#073845] text-[#81f3ff]'
                : recorder.guidanceTone === 'error'
                  ? 'bg-[#4d1118] text-[#ff9ca8]'
                  : 'bg-white/10 text-white/84'
          }`}>
            {recorder.guidanceText}
          </div>

          {recorder.error ? (
            <div className="rounded-2xl bg-[#4d1118] px-4 py-3 text-sm text-[#ffccd2]">{recorder.error}</div>
          ) : null}
        </div>

        <div className="flex items-center justify-center gap-3">
          {recorder.isPreviewing ? (
            <>
              <button
                type="button"
                onClick={recorder.retake}
                className="rounded-full border border-white/14 px-5 py-3 text-sm font-semibold text-white/80"
              >
                Re-record
              </button>
              <button
                type="button"
                onClick={() => void recorder.confirmSend()}
                disabled={recorder.isSending}
                className="rounded-full bg-[#34c759] px-6 py-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                Send
              </button>
            </>
          ) : recorder.isRecording ? (
            <button
              type="button"
              onClick={recorder.stopRecording}
              className="flex h-[78px] w-[78px] items-center justify-center rounded-full border-4 border-[#ff7b7b] bg-[#ff7b7b]/20"
            >
              <span className="h-8 w-8 rounded-md bg-[#ff3b30]" />
            </button>
          ) : (
            <button
              type="button"
              onClick={recorder.startRecording}
              disabled={!recorder.stream || recorder.permissionPending}
              className="flex h-[78px] w-[78px] items-center justify-center rounded-full border-4 border-white/85 bg-transparent disabled:opacity-40"
            >
              <span className="h-14 w-14 rounded-full bg-[#ff3b30]" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
