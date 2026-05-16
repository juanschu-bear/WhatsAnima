import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { fetchReadoutSessions, type ReadoutSession, type ReadoutData, type SignalMoment } from './data'
import './readouts.css'

type View = 'cover' | 'list' | 'detail'

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const day = d.getDate()
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
  const month = months[d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${month}, ${hh}:${mm}`
}

function tagClass(tag: string): string {
  const t = tag.toLowerCase()
  if (t.includes('incongruencia') || t.includes('vulnerabilidad')) return 'ro-stag-red'
  if (t.includes('energia') || t.includes('conexion') || t.includes('decision')) return 'ro-stag-teal'
  if (t.includes('proteccion') || t.includes('evasion')) return 'ro-stag-amber'
  return 'ro-stag-purple'
}

export default function ReadoutsPage() {
  const { user } = useAuth()
  const [view, setView] = useState<View>('cover')
  const [sessions, setSessions] = useState<ReadoutSession[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedSession, setSelectedSession] = useState<ReadoutSession | null>(null)

  useEffect(() => {
    if (!user?.id) return
    setLoading(true)
    fetchReadoutSessions(user.id)
      .then(setSessions)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [user?.id])

  function openList() {
    setView('list')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function openDetail(session: ReadoutSession) {
    setSelectedSession(session)
    setView('detail')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function goBack(to: View) {
    setView(to)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="readouts-root">
      {view === 'cover' && <CoverView onOpen={openList} />}
      {view === 'list' && (
        <ListView
          sessions={sessions}
          loading={loading}
          onBack={() => goBack('cover')}
          onSelect={openDetail}
        />
      )}
      {view === 'detail' && selectedSession?.readout_json && (
        <DetailView
          session={selectedSession}
          readout={selectedSession.readout_json}
          onBack={() => goBack('list')}
        />
      )}
    </div>
  )
}

function CoverView({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="ro-cover" onClick={onOpen}>
      <div className="ro-book-3d">
        <div className="ro-book-obj">
          <div className="ro-book-face">
            <div className="ro-premium-ribbon">PREMIUM</div>
            <span className="ro-brand">O N I O K O</span>
            <div className="ro-book-line" />
            <div className="ro-book-title">Lecturas<br />de Session</div>
            <div className="ro-book-sub">
              Cada conversacion deja huellas invisibles. Aqui viven las radiografias que tus avatares
              escriben despues de cada encuentro.
            </div>
            <div className="ro-book-year">2 0 2 6</div>
          </div>
        </div>
      </div>
      <span className="ro-tap">tap to open</span>
    </div>
  )
}

function ListView({
  sessions,
  loading,
  onBack,
  onSelect,
}: {
  sessions: ReadoutSession[]
  loading: boolean
  onBack: () => void
  onSelect: (s: ReadoutSession) => void
}) {
  return (
    <div className="ro-list">
      <button className="ro-back" onClick={onBack}>
        &#8592; Volver
      </button>
      <h2>
        Tus <em>lecturas</em>
      </h2>
      <p className="ro-list-intro">
        No son resumenes. Son radiografias de lo que paso entre lineas.
      </p>
      <div className="ro-premium-badge">
        <div className="ro-premium-dot" />
        Premium feature, actualmente activo para tu cuenta
      </div>

      {loading && <div className="ro-empty">Cargando lecturas...</div>}

      {!loading && sessions.length === 0 && (
        <div className="ro-empty">
          Todavia no hay lecturas. Haz una videollamada de mas de un minuto y tu avatar escribira una lectura conductual automaticamente.
        </div>
      )}

      {sessions.map((s) => (
        <div key={s.session_id} className="ro-scard" onClick={() => onSelect(s)}>
          <div className="ro-scard-av">
            <div className="ro-scard-av-in">{getInitials(s.avatar_name)}</div>
          </div>
          <div className="ro-scard-info">
            <div className="ro-scard-title">
              {s.readout_json?.title || 'Lectura de session'}
            </div>
            <div className="ro-scard-meta">
              <span>{s.user_name || 'Participante'}</span>
              <span>&middot;</span>
              <span>{s.avatar_name}</span>
              <span>&middot;</span>
              <span>{formatDate(s.created_at)}</span>
              <span>&middot;</span>
              <span>{Math.round(s.call_duration_seconds / 60)} min</span>
            </div>
          </div>
          <span className="ro-scard-arrow">&#8594;</span>
        </div>
      ))}
    </div>
  )
}

function DetailView({
  session,
  readout,
  onBack,
}: {
  session: ReadoutSession
  readout: ReadoutData
  onBack: () => void
}) {
  const durationMin = Math.round(session.call_duration_seconds / 60)

  return (
    <div className="ro-detail">
      <button className="ro-back" onClick={onBack}>
        &#8592; Volver a lecturas
      </button>

      <div className="ro-topline">
        <div className="ro-topdot" />
        Lectura de session
      </div>

      <div className="ro-ctx">
        {readout.contact_name || session.user_name} &middot; {readout.avatar_name || session.avatar_name} &middot;{' '}
        {formatDate(session.created_at)} &middot; {durationMin} min
      </div>

      <h1>
        {readout.title.split(/(\s)/).map((word, i) => {
          if (i === readout.title.split(/(\s)/).length - 1) {
            return <em key={i}>{word}</em>
          }
          return word
        })}
      </h1>

      <div className="ro-voice">
        <div className="ro-vring">
          <div className="ro-vring-in">{getInitials(readout.avatar_name || session.avatar_name)}</div>
        </div>
        <div>
          <div className="ro-vname">{readout.avatar_name || session.avatar_name}</div>
          <div className="ro-vrole">Lectura conductual</div>
        </div>
      </div>

      <div className="ro-narr">
        {readout.narrative_blocks.map((block, i) => (
          <p key={`n-${i}`}>{block}</p>
        ))}
      </div>

      {readout.signal_moments.length > 0 && (
        <>
          {readout.signal_moments.map((moment: SignalMoment, i: number) => (
            <div key={`sm-${i}`} className="ro-smom">
              <div className="ro-smom-time">{moment.time}</div>
              <div className="ro-smom-title">{moment.title}</div>
              <p>{moment.body}</p>
              <span className={`ro-stag ${tagClass(moment.tag)}`}>{moment.tag}</span>
            </div>
          ))}
        </>
      )}

      {readout.perception_notes.length > 0 &&
        readout.perception_notes.map((note, i) => (
          <div key={`pn-${i}`} className="ro-pnote">
            <div className="ro-pnote-label">Observacion conductual</div>
            <p>{note}</p>
          </div>
        ))}

      {readout.next_steps.length > 0 && (
        <>
          <div className="ro-divider" />
          <div className="ro-nxst">
            <h2>
              Lo que viene <em>despues</em>
            </h2>
            {readout.next_steps.map((step, i) => (
              <div key={`ns-${i}`} className="ro-nxi">
                <span
                  className={`ro-nxw ${
                    step.owner.toLowerCase() === readout.avatar_name.toLowerCase()
                      ? 'ro-nxw-avatar'
                      : 'ro-nxw-user'
                  }`}
                >
                  {step.owner}
                </span>
                <span className="ro-nxt">{step.action}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {readout.closing_read && (
        <div className="ro-closing">
          <div className="ro-closing-header">
            <div className="ro-closing-dot" />
            <span className="ro-closing-label">
              Lectura final de {readout.avatar_name || session.avatar_name}
            </span>
          </div>
          <p>{readout.closing_read}</p>
        </div>
      )}

      <div className="ro-footer">ONIOKO &middot; Observational Perception Models</div>
    </div>
  )
}
