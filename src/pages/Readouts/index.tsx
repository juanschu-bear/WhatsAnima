import { useEffect, useState } from 'react'
import { getStoredLocale, t } from '../../lib/i18n'
import { fetchReadoutsByAvatar, type AvatarGroup, type UserGroup, type ReadoutSession, type ReadoutData, type SignalMoment } from './data'
import './readouts.css'

type View = 'cover' | 'avatars' | 'users' | 'sessions' | 'detail'

function initials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

function cleanMd(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^TÍTULO:\s*/i, '')
    .replace(/^TITLE:\s*/i, '')
    .replace(/^NARRATIVE:\s*/i, '')
    .trim()
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  const day = d.getDate()
  const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${months[d.getMonth()]}, ${hh}:${mm}`
}

function tagClass(tag: string): string {
  const lo = tag.toLowerCase()
  if (lo.includes('incongruencia') || lo.includes('vulnerabilidad')) return 'ro-stag-red'
  if (lo.includes('energia') || lo.includes('conexion') || lo.includes('decision')) return 'ro-stag-teal'
  if (lo.includes('proteccion') || lo.includes('evasion')) return 'ro-stag-amber'
  return 'ro-stag-purple'
}

export default function ReadoutsPage() {
  const locale = getStoredLocale()
  const [view, setView] = useState<View>('cover')
  const [data, setData] = useState<AvatarGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [selAvatar, setSelAvatar] = useState<AvatarGroup | null>(null)
  const [selUser, setSelUser] = useState<UserGroup | null>(null)
  const [selSession, setSelSession] = useState<ReadoutSession | null>(null)

  useEffect(() => {
    setLoading(true)
    fetchReadoutsByAvatar()
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  function go(v: View) { setView(v); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  function openAvatars() { go('avatars') }
  function openUsers(a: AvatarGroup) { setSelAvatar(a); go('users') }
  function openSessions(u: UserGroup) { setSelUser(u); go('sessions') }
  function openDetail(s: ReadoutSession) { setSelSession(s); go('detail') }

  return (
    <div className="readouts-root">
      {view === 'cover' && <CoverView onOpen={openAvatars} locale={locale} />}
      {view === 'avatars' && (
        <AvatarsView data={data} loading={loading} onBack={() => go('cover')} onSelect={openUsers} locale={locale} />
      )}
      {view === 'users' && selAvatar && (
        <UsersView avatar={selAvatar} onBack={() => go('avatars')} onSelect={openSessions} locale={locale} />
      )}
      {view === 'sessions' && selAvatar && selUser && (
        <SessionsView avatar={selAvatar} user={selUser} onBack={() => go('users')} onSelect={openDetail} locale={locale} />
      )}
      {view === 'detail' && selSession && (
        selSession.readout_json ? (
          <DetailView session={selSession} readout={selSession.readout_json} avatar={selAvatar} user={selUser} onBack={() => go('sessions')} locale={locale} />
        ) : (
          <div className="ro-page ro-fade-in">
            <button className="ro-back" onClick={() => go('sessions')}>&#8592; {t(locale, 'readoutsBack')}</button>
            <p style={{ color: 'rgba(226,234,243,0.4)', marginTop: 32 }}>{t(locale, 'readoutsEmpty')}</p>
          </div>
        )
      )}
    </div>
  )
}

/* ===== LEVEL 1: BOOK COVER ===== */

function CoverView({ onOpen, locale }: { onOpen: () => void; locale: ReturnType<typeof getStoredLocale> }) {
  const [opening, setOpening] = useState(false)
  function handleOpen() { setOpening(true); setTimeout(onOpen, 1100) }
  const titleLines = t(locale, 'readoutsTitle').split('\n')

  return (
    <div className={`ro-cover ${opening ? 'opening' : ''}`}>
      <button className="ro-back" style={{ position: 'absolute', top: 24, left: 24, zIndex: 10 }} onClick={(e) => { e.stopPropagation(); window.history.back() }}>&#8592; {t(locale, 'readoutsBack')}</button>
      <div className="ro-book-3d" onClick={handleOpen} style={{ cursor: 'pointer' }}>
        <div className="ro-book-obj">
          <div className="ro-book-face">
            <div className="ro-premium-ribbon">PREMIUM</div>
            <span className="ro-brand">O N I O K O</span>
            <div className="ro-book-line" />
            <div className="ro-book-title">{titleLines.map((l, i) => <span key={i}>{l}{i < titleLines.length - 1 && <br />}</span>)}</div>
            <div className="ro-book-sub">{t(locale, 'readoutsSubtitle')}</div>
            <div className="ro-book-year">2 0 2 6</div>
          </div>
        </div>
      </div>
      <span className="ro-tap">{t(locale, 'readoutsTap')}</span>
    </div>
  )
}

/* ===== LEVEL 2: AVATAR SELECTION ===== */

function AvatarsView({ data, loading, onBack, onSelect, locale }: {
  data: AvatarGroup[]; loading: boolean; onBack: () => void; onSelect: (a: AvatarGroup) => void; locale: ReturnType<typeof getStoredLocale>
}) {
  return (
    <div className="ro-page ro-fade-in">
      <button className="ro-back" onClick={onBack}>&#8592; {t(locale, 'readoutsBack')}</button>
      <h2>{t(locale, 'readoutsYourReadouts')} <em>{t(locale, 'readoutsReadouts')}</em></h2>
      <p className="ro-page-intro">{t(locale, 'readoutsIntro')}</p>
      <div className="ro-premium-badge"><div className="ro-premium-dot" />{t(locale, 'readoutsPremium')}</div>

      {loading && <div className="ro-empty">{t(locale, 'readoutsLoading')}</div>}
      {!loading && data.length === 0 && <div className="ro-empty">{t(locale, 'readoutsEmpty')}</div>}

      <div className="ro-avatar-grid">
        {data.map((a, i) => (
          <div
            key={a.avatar_name}
            className="ro-avatar-card"
            onClick={() => a.total_sessions > 0 ? onSelect(a) : undefined}
            style={{
              animationDelay: `${i * 0.08}s`,
              opacity: a.total_sessions > 0 ? 1 : 0.4,
              cursor: a.total_sessions > 0 ? 'pointer' : 'default',
            }}
          >
            <div className="ro-ac-ring"><div className="ro-ac-ring-in">{initials(a.avatar_name)}</div></div>
            <h3>{a.avatar_name}</h3>
            <div className="ro-ac-stats">
              <span>{a.total_sessions} {a.total_sessions === 1 ? 'session' : 'sessions'}</span>
              {a.users.length > 0 && <><span>&middot;</span><span>{a.users.length} {a.users.length === 1 ? 'contact' : 'contacts'}</span></>}
            </div>
            <div className="ro-ac-glow" />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ===== LEVEL 3: USERS FOR AVATAR ===== */

function UsersView({ avatar, onBack, onSelect, locale }: {
  avatar: AvatarGroup; onBack: () => void; onSelect: (u: UserGroup) => void; locale: ReturnType<typeof getStoredLocale>
}) {
  return (
    <div className="ro-page ro-slide-in">
      <button className="ro-back" onClick={onBack}>&#8592; {t(locale, 'readoutsBack')}</button>
      <div className="ro-breadcrumb">
        <button onClick={onBack}>{t(locale, 'readoutsReadouts')}</button>
        <span className="ro-bc-sep">&#8250;</span>
        <span className="ro-bc-current">{avatar.avatar_name}</span>
      </div>

      <h2><em>{avatar.avatar_name}</em></h2>
      <p className="ro-page-intro">{avatar.users.length} {avatar.users.length === 1 ? 'contact' : 'contacts'} &middot; {avatar.total_sessions} sessions</p>

      {avatar.users.map((u, i) => (
        <div key={u.user_name} className="ro-user-card" onClick={() => onSelect(u)} style={{ animationDelay: `${i * 0.06}s` }}>
          <div className="ro-uc-avatar">{initials(u.user_name)}</div>
          <div className="ro-uc-info">
            <div className="ro-uc-name">{u.user_name}</div>
            <div className="ro-uc-meta">
              <span>{u.sessions.length} {u.sessions.length === 1 ? 'session' : 'sessions'}</span>
              <span>&middot;</span>
              <span>{u.total_minutes} min</span>
            </div>
          </div>
          <span className="ro-uc-arrow">&#8594;</span>
        </div>
      ))}
    </div>
  )
}

/* ===== LEVEL 4: SESSIONS FOR USER ===== */

function SessionsView({ avatar, user, onBack, onSelect, locale }: {
  avatar: AvatarGroup; user: UserGroup; onBack: () => void; onSelect: (s: ReadoutSession) => void; locale: ReturnType<typeof getStoredLocale>
}) {
  return (
    <div className="ro-page ro-slide-in">
      <button className="ro-back" onClick={onBack}>&#8592; {t(locale, 'readoutsBack')}</button>
      <div className="ro-breadcrumb">
        <button onClick={() => { onBack(); }}>{avatar.avatar_name}</button>
        <span className="ro-bc-sep">&#8250;</span>
        <span className="ro-bc-current">{user.user_name}</span>
      </div>

      <h2>{user.user_name} &times; <em>{avatar.avatar_name}</em></h2>
      <p className="ro-page-intro">{user.sessions.length} {user.sessions.length === 1 ? 'session' : 'sessions'} &middot; {user.total_minutes} min total</p>

      {user.sessions.map((s, i) => (
        <div key={s.session_id} className="ro-session-card" onClick={() => onSelect(s)} style={{ animationDelay: `${i * 0.06}s` }}>
          <div className="ro-sc-dot" />
          <div className="ro-sc-info">
            <div className="ro-sc-title">{s.readout_json?.title || t(locale, 'readoutsSessionReadout')}</div>
            <div className="ro-sc-meta">{fmtDate(s.created_at)} &middot; {Math.round(s.call_duration_seconds / 60)} min</div>
          </div>
          <span className="ro-sc-arrow">&#8594;</span>
        </div>
      ))}
    </div>
  )
}

/* ===== LEVEL 5: READOUT DETAIL ===== */

function DetailView({ session, readout, avatar, user, onBack, locale }: {
  session: ReadoutSession; readout: ReadoutData; avatar: AvatarGroup | null; user: UserGroup | null
  onBack: () => void; locale: ReturnType<typeof getStoredLocale>
}) {
  const durationMin = Math.round(session.call_duration_seconds / 60)

  return (
    <div className="ro-detail ro-fade-in">
      <button className="ro-back" onClick={onBack}>&#8592; {t(locale, 'readoutsBack')}</button>

      <div className="ro-breadcrumb">
        {avatar && <><button onClick={onBack}>{avatar.avatar_name}</button><span className="ro-bc-sep">&#8250;</span></>}
        {user && <><button onClick={onBack}>{user.user_name}</button><span className="ro-bc-sep">&#8250;</span></>}
        <span className="ro-bc-current">{cleanMd(readout.title)}</span>
      </div>

      <div className="ro-topline"><div className="ro-topdot" />{t(locale, 'readoutsSessionReadout')}</div>

      <div className="ro-ctx">
        {readout.contact_name || session.user_name} &middot; {readout.avatar_name || session.avatar_name} &middot; {fmtDate(session.created_at)} &middot; {durationMin} min
      </div>

      <h1>{cleanMd(readout.title).split(/(\s)/).map((word, i, arr) => {
        if (i === arr.length - 1) return <em key={i}>{word}</em>
        return word
      })}</h1>

      <div className="ro-voice">
        <div className="ro-vring"><div className="ro-vring-in">{initials(readout.avatar_name || session.avatar_name)}</div></div>
        <div><div className="ro-vname">{readout.avatar_name || session.avatar_name}</div><div className="ro-vrole">{t(locale, 'readoutsBehavioralObs')}</div></div>
      </div>

      <div className="ro-narr">
        {readout.narrative_blocks.map((block, i) => <p key={`n-${i}`}>{cleanMd(block)}</p>)}
      </div>

      {readout.signal_moments.map((moment: SignalMoment, i: number) => (
        <div key={`sm-${i}`} className="ro-smom">
          <div className="ro-smom-time">{moment.time}</div>
          <div className="ro-smom-title">{cleanMd(moment.title)}</div>
          <p>{cleanMd(moment.body)}</p>
          <span className={`ro-stag ${tagClass(moment.tag)}`}>{moment.tag}</span>
        </div>
      ))}

      {readout.perception_notes.map((note, i) => (
        <div key={`pn-${i}`} className="ro-pnote">
          <div className="ro-pnote-label">{t(locale, 'readoutsBehavioralObs')}</div>
          <p>{cleanMd(note)}</p>
        </div>
      ))}

      {readout.next_steps.length > 0 && (
        <>
          <div className="ro-divider" />
          <div className="ro-nxst">
            <h2>{t(locale, 'readoutsNextSteps')} <em>{t(locale, 'readoutsNextStepsEm')}</em></h2>
            {readout.next_steps.map((step, i) => (
              <div key={`ns-${i}`} className="ro-nxi">
                <span className={`ro-nxw ${step.owner.toLowerCase() === (readout.avatar_name || '').toLowerCase() ? 'ro-nxw-avatar' : 'ro-nxw-user'}`}>{step.owner}</span>
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
            <span className="ro-closing-label">{t(locale, 'readoutsFinalReading')} {readout.avatar_name || session.avatar_name}</span>
          </div>
          <p>{cleanMd(readout.closing_read)}</p>
        </div>
      )}

      <div className="ro-footer">{t(locale, 'readoutsFooter')}</div>
    </div>
  )
}
