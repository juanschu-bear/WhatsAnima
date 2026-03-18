import { useState, type RefObject } from 'react'

const PLAY_SVG = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
)

const PAUSE_SVG = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
)

interface VideoRecorderProps {
  open: boolean
  recordingMode: 'idle' | 'recording' | 'stopping'
  recordingSeconds: number
  progressRingOffset: number
  timeWarning: boolean
  videoHint: string
  videoStatusText: string
  validationText: string
  validationType: '' | 'warning' | 'error' | 'success'
  canRecord: boolean
  previewMode: boolean
  previewDuration: number
  previewCurrentTime: number
  previewProgress: number
  previewPlaying: boolean
  videoPreviewRef: RefObject<HTMLVideoElement | null>
  onClose: () => void
  onRecordClick: () => Promise<void>
  onRotate: () => void
  onSend: () => Promise<void>
  onTogglePreviewPlayback: () => void
  onSeekPreview: (ratio: number) => void
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0))
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`
}

export function VideoRecorder({
  open,
  recordingMode,
  recordingSeconds,
  progressRingOffset,
  timeWarning,
  videoHint,
  videoStatusText,
  validationText,
  validationType,
  canRecord,
  previewMode,
  previewDuration,
  previewCurrentTime,
  previewProgress,
  previewPlaying,
  videoPreviewRef,
  onClose,
  onRecordClick,
  onRotate,
  onSend,
  onTogglePreviewPlayback,
  onSeekPreview,
}: VideoRecorderProps) {
  const [isSending, setIsSending] = useState(false)

  if (!open) return null

  async function handleSendClick() {
    if (isSending) return
    setIsSending(true)
    try {
      await onSend()
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className={`video-overlay active ${recordingMode === 'recording' ? 'recording' : ''} ${timeWarning ? 'time-warning' : ''} ${previewMode ? 'preview' : ''}`}>
      <div className="video-overlay-header">
        <button className="video-cancel-btn" type="button" onClick={onClose}>Cancel</button>
        <span className="video-timer">{formatDuration(recordingMode === 'recording' ? recordingSeconds : previewMode ? previewDuration : 0)}</span>
        <span className="video-status-text">{videoStatusText}</span>
      </div>

      <div className="video-circle-container">
        <svg className="video-progress-ring" viewBox="0 0 260 260">
          <circle className="progress-ring-bg" cx="130" cy="130" r="124" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="6" />
          <circle
            className="progress-ring-fill"
            cx="130"
            cy="130"
            r="124"
            fill="none"
            stroke={timeWarning ? '#ff3b30' : '#34c759'}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray="779.4"
            strokeDashoffset={progressRingOffset}
            transform="rotate(-90 130 130)"
          />
        </svg>
        <div className="video-circle">
          <video ref={videoPreviewRef} autoPlay muted playsInline />
        </div>
      </div>

      <div className="video-validation-below">
        <span className={`validation-msg${validationType ? ` ${validationType}` : ''}`}>{validationText}</span>
      </div>

      <div className="video-controls">
        {previewMode ? (
          <div
            style={{
              display: 'flex',
              width: 'min(320px, calc(100vw - 40px))',
              alignItems: 'center',
              gap: '10px',
              padding: '10px 12px',
              borderRadius: '18px',
              background: 'rgba(0, 0, 0, 0.42)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              marginBottom: '8px',
            }}
          >
            <button
              type="button"
              aria-label="Play preview"
              onClick={onTogglePreviewPlayback}
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '999px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255, 255, 255, 0.16)',
                color: '#fff',
                flexShrink: '0',
              }}
            >
              {previewPlaying ? PAUSE_SVG : PLAY_SVG}
            </button>
            <span style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.86)', fontVariantNumeric: 'tabular-nums', minWidth: '34px' }}>
              {formatDuration(previewCurrentTime)}
            </span>
            <div
              role="slider"
              tabIndex={0}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(previewProgress * 100)}
              style={{ position: 'relative', flex: '1', height: '18px', display: 'flex', alignItems: 'center', touchAction: 'none', cursor: 'pointer' }}
              onClick={(event) => {
                const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect()
                const ratio = (event.clientX - rect.left) / rect.width
                onSeekPreview(ratio)
              }}
            >
              <div style={{ position: 'absolute', left: 0, right: 0, height: '4px', borderRadius: '999px', background: 'rgba(255, 255, 255, 0.22)' }}>
                <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, previewProgress * 100))}%`, borderRadius: '999px', background: '#00d4ff' }} />
              </div>
              <div style={{ position: 'absolute', top: '50%', left: `${Math.max(0, Math.min(100, previewProgress * 100))}%`, width: '12px', height: '12px', borderRadius: '999px', background: '#fff', boxShadow: '0 0 8px rgba(0, 212, 255, 0.45)', transform: 'translate(-50%, -50%)' }} />
            </div>
            <span style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.86)', fontVariantNumeric: 'tabular-nums', minWidth: '34px', textAlign: 'right' }}>
              {formatDuration(previewDuration)}
            </span>
          </div>
        ) : null}

        <button className="video-record-btn" type="button" disabled={!canRecord && recordingMode !== 'recording'} onClick={() => void onRecordClick()}>
          <span className="record-dot" />
        </button>

        <button className="video-rotate-btn" type="button" title="Rotate 90°" onClick={onRotate}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>

        <button className="video-send-btn" type="button" onClick={() => void handleSendClick()} disabled={isSending}>
          {isSending ? (
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              Sending...
            </span>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
          )}
        </button>

        <div className="video-hint">{videoHint}</div>
      </div>
    </div>
  )
}
