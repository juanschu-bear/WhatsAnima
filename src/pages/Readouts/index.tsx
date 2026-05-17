import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { getStoredLocale, t } from '../../lib/i18n'
import { fetchReadoutSessions, type ReadoutSession, type ReadoutData, type SignalMoment } from './data'
import './readouts.css'

type View = 'cover' | 'list' | 'detail'

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
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
  const locale = getStoredLocale()

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
      {view === 'cover' && <CoverView onOpen={openList} locale={locale} />}
      {view === 'list' && (
        <ListView
          sessions={sessions}
          loading={loading}
          onBack={() => goBack('cover')}
          onSelect={openDetail}
          locale={locale}
        />
      )}
      {view === 'detail' && selectedSession?.readout_json && (
        <DetailView
          session={selectedSession}
          readout={selectedSession.readout_json}
          onBack={() => goBack('list')}
          locale={locale}
        />
      )}
    </div>
  )
}

function CoverView({ onOpen, locale }: { onOpen: () => void; locale: ReturnType<typeof getStoredLocale> }) {
  const [opening, setOpening] = useState(false)

  function handleOpen() {
    setOpening(true)
    setTimeout(onOpen, 1100)
  }

  const titleLines = t(locale, 'readoutsTitle').split('\n')

  return (
    <div className={`ro-cover ${opening ? 'opening' : ''}`} onClick={handleOpen}>
      <div className="ro-book-3d">
        <div className="ro-book-obj">
          <div className="ro-book-face">
            <div className="ro-premium-ribbon">PREMIUM</div>
            <span className="ro-brand">O N I O K O</span>
            <div className="ro-book-line" />
            <div className="ro-book-title">{titleLines.map((line, i) => <span key={i}>{line}{i < titleLines.length - 1 && <br />}</span>)}</div>
            <div className="ro-book-sub">{t(locale, 'readoutsSubtitle')}</div>
            <div className="ro-book-year">2 0 2 6</div>
          </div>
        </div>
      </div>
      <span className="ro-tap">{t(locale, 'readoutsTap')}</span>
    </div>
  )
}

function ListView({
  sessions,
  loading,
  onBack,
  onSelect,
  locale,
}: {
  sessions: ReadoutSession[]
  loading: boolean
  onBack: () => void
  onSelect: (s: ReadoutSession) => void
  locale: ReturnType<typeof getStoredLocale>
}) {
  return (
    <div className="ro-list">
      <button className="ro-back" onClick={onBack}>
        &#8592; {t(locale, 'readoutsBack')}
      </button>
      <h2>
        {t(locale, 'readoutsYourReadouts')} <em>{t(locale, 'readoutsReadouts')}</em>
      </h2>
      <p className="ro-list-intro">{t(locale, 'readoutsIntro')}</p>
      <div className="ro-premium-badge">
        <div className="ro-premium-dot" />
        {t(locale, 'readoutsPremium')}
      </div>

      {loading && <div className="ro-empty">{t(locale, 'readoutsLoading')}</div>}

      {!loading && sessions.length === 0 && (
        <div className="ro-empty">{t(locale, 'readoutsEmpty')}</div>
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
  locale,
}: {
  session: ReadoutSession
  readout: ReadoutData
  onBack: () => void
  locale: ReturnType<typeof getStoredLocale>
}) {
  const durationMin = Math.round(session.call_duration_seconds / 60)

  return (
    <div className="ro-detail">
      <button className="ro-back" onClick={onBack}>
        &#8592; {t(locale, 'readoutsBackToReadouts')}
      </button>

      <div className="ro-topline">
        <div className="ro-topdot" />
        {t(locale, 'readoutsSessionReadout')}
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
            <div className="ro-pnote-label">{t(locale, 'readoutsBehavioralObs')}</div>
            <p>{note}</p>
          </div>
        ))}

      {readout.next_steps.length > 0 && (
        <>
          <div className="ro-divider" />
          <div className="ro-nxst">
            <h2>
              {t(locale, 'readoutsNextSteps')} <em>{t(locale, 'readoutsNextStepsEm')}</em>
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
              {t(locale, 'readoutsFinalReading')} {readout.avatar_name || session.avatar_name}
            </span>
          </div>
          <p>{readout.closing_read}</p>
        </div>
      )}

      <div className="ro-footer">{t(locale, 'readoutsFooter')}</div>
    </div>
  )
}
