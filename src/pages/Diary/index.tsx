import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AVATARS_BY_ID,
  DIARY_AVATARS,
  avatarFromApi,
  type DiaryAvatar,
} from './avatars'
import {
  fetchAvatars,
  fetchDiary,
  parseEntry,
  extractSkills,
  groupByDay,
  dedupEntries,
  aggregateByTagType,
  type ParsedEntry,
  type ParsedTag,
  type TagAggregate,
} from './mempalace'
import './diary.css'

type Filter = 'all' | 'skills' | 'patterns' | 'contacts'

const SKILL_COLOR_CLASSES = ['sg', 'sp', 'sb', 'sa', 'sr', 'spk']

function ensureFonts() {
  if (typeof document === 'undefined') return
  if (document.getElementById('diary-fonts')) return
  const link = document.createElement('link')
  link.id = 'diary-fonts'
  link.rel = 'stylesheet'
  link.href =
    'https://fonts.googleapis.com/css2?family=Caveat:wght@400;500;600;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400;1,500&display=swap'
  document.head.appendChild(link)
}

function DiaryShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    ensureFonts()
  }, [])
  return <div className="diary-root">{children}</div>
}

export function DiaryEntryRoute() {
  return (
    <DiaryShell>
      <EntryScreen />
    </DiaryShell>
  )
}

export function DiarySelectRoute() {
  return (
    <DiaryShell>
      <SelectScreen />
    </DiaryShell>
  )
}

export function DiaryAvatarRoute() {
  return (
    <DiaryShell>
      <DiaryRouteWrapper />
    </DiaryShell>
  )
}

export default DiaryEntryRoute

function EntryScreen() {
  const navigate = useNavigate()
  const [opening, setOpening] = useState(false)

  function openBook() {
    if (opening) return
    setOpening(true)
    window.setTimeout(() => navigate('/diary/select'), 800)
  }

  return (
    <div
      className={`screen entry-screen${opening ? ' opening' : ''}`}
      onClick={openBook}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openBook()}
    >
      <div className="book-glow" />
      <div className="book-wrapper">
        <div className="book">
          <div className="book-spine" />
          <div className="book-edge-top" />
          <div className="book-edge-bottom" />
          <div className="book-gold-frame" />
          <div className="book-label">ONIOKO</div>
          <div className="book-ornament-top" />
          <div className="book-title">Extended Avatars Diary</div>
          <div className="book-subtitle">
            Private reflections, lessons, patterns, and shifts in how they think.
          </div>
          <div className="book-ornament-bottom" />
          <div className="book-year">2 0 2 6</div>
        </div>
      </div>
      <div className="entry-hint">tap to open</div>
    </div>
  )
}

interface AvatarWithCount {
  avatar: DiaryAvatar
  entryCount: number
}

function SelectScreen() {
  const navigate = useNavigate()
  const [items, setItems] = useState<AvatarWithCount[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchAvatars()
      .then((apiAvatars) => {
        if (cancelled) return
        const merged = apiAvatars.map((a) => ({
          avatar: avatarFromApi(a),
          entryCount: extractCount(a),
        }))
        setItems(merged)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load avatars')
        setItems(DIARY_AVATARS.map((a) => ({ avatar: a, entryCount: 0 })))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="screen select-screen">
      <button className="back-btn" onClick={() => navigate('/diary')}>
        ← Back
      </button>
      <div className="select-header">
        <div className="select-label">Diary</div>
        <h1 className="select-title">Whose diary would you like to read?</h1>
        <p className="select-sub">
          Avatars keep private reflections, lessons, patterns, and shifts in how they think.
        </p>
      </div>
      <div className="avatar-grid">
        {(items ?? []).map(({ avatar: a, entryCount }) => (
          <button
            key={a.agentId}
            className="avatar-card"
            onClick={() => navigate(`/diary/${a.agentId}`)}
          >
            <div className="card-top">
              <span>{a.number}</span>
              <span>{a.wing}</span>
            </div>
            <div className="card-circle">{a.initials}</div>
            <div className="card-name">{a.name}</div>
            <div className="card-role">{a.expertise}</div>
            <span className={`card-badge ${a.type.toLowerCase()}`}>{a.type}</span>
            <div className="card-bottom">
              <span className="card-entries">
                {entryCount} {entryCount === 1 ? 'entry' : 'entries'}
              </span>
              <span className="card-arrow">→</span>
            </div>
          </button>
        ))}
      </div>
      {error && items && (
        <p style={{ marginTop: 30, color: '#6a6050', fontStyle: 'italic', fontSize: 13 }}>
          Could not reach diary API ({error}). Showing cached avatars.
        </p>
      )}
    </div>
  )
}

function extractCount(a: {
  entry_count?: number
  count?: number
  total?: number
  entries?: number
}): number {
  return Number(a.entry_count ?? a.count ?? a.total ?? a.entries ?? 0) || 0
}

function DiaryRouteWrapper() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const [avatar, setAvatar] = useState<DiaryAvatar | null>(() =>
    agentId ? AVATARS_BY_ID[agentId] ?? null : null,
  )
  const [resolving, setResolving] = useState(!avatar)

  useEffect(() => {
    if (avatar || !agentId) return
    let cancelled = false
    fetchAvatars()
      .then((list) => {
        if (cancelled) return
        const match = list.find((a) => a.agent_id === agentId)
        if (match) setAvatar(avatarFromApi(match))
        else
          setAvatar({
            agentId,
            name: agentId,
            initials: agentId.slice(0, 2).toUpperCase(),
            expertise: '',
            wing: '',
            number: '',
            type: 'Premium',
          })
      })
      .catch(() => {
        if (cancelled) return
        setAvatar({
          agentId,
          name: agentId,
          initials: agentId.slice(0, 2).toUpperCase(),
          expertise: '',
          wing: '',
          number: '',
          type: 'Premium',
        })
      })
      .finally(() => {
        if (!cancelled) setResolving(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId, avatar])

  if (!agentId) {
    navigate('/diary/select', { replace: true })
    return null
  }

  if (resolving || !avatar) {
    return (
      <div className="screen diary-screen">
        <div className="diary">
          <div className="diary-status">Opening the pages…</div>
        </div>
      </div>
    )
  }

  return <DiaryScreen avatar={avatar} />
}

function DiaryScreen({ avatar }: { avatar: DiaryAvatar }) {
  const navigate = useNavigate()
  const [entries, setEntries] = useState<ParsedEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [skillsShut, setSkillsShut] = useState(false)
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setEntries(null)
    setOpenDays({})
    fetchDiary(avatar.agentId, 100)
      .then((data) => {
        if (cancelled) return
        const parsed = (data.entries ?? []).map(parseEntry)
        setEntries(dedupEntries(parsed))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load diary')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [avatar.agentId])

  const skills = useMemo(() => (entries ? extractSkills(entries) : []), [entries])
  const groups = useMemo(() => (entries ? groupByDay(entries) : []), [entries])
  const skillAggs = useMemo(
    () => (entries ? aggregateByTagType(entries, 'skill') : []),
    [entries],
  )
  const patternAggs = useMemo(
    () => (entries ? aggregateByTagType(entries, 'pattern') : []),
    [entries],
  )
  const contactAggs = useMemo(
    () => (entries ? aggregateByTagType(entries, 'contact') : []),
    [entries],
  )

  function jumpToDate(date: string) {
    setOpenDays((prev) => ({ ...prev, [date]: true }))
    window.requestAnimationFrame(() => {
      const el = document.getElementById(`dg-${date}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const firstName = avatar.name.startsWith('Prof.') ? avatar.name : avatar.name.split(' ')[0]
  const total = entries?.length ?? 0

  return (
    <div className="screen diary-screen">
      <button className="diary-back" onClick={() => navigate('/diary/select')}>
        ← Back to diaries
      </button>
      <div className="diary">
        <div className="diary-header">
          <div className="diary-circle">{avatar.initials}</div>
          <h1 className="diary-name">{firstName}'s Diary</h1>
          <p className="diary-sub">
            What I learned, what I noticed, what I would do differently.
          </p>
          <p className="diary-count">
            {loading ? 'Loading…' : `${total} ${total === 1 ? 'entry' : 'entries'}`}
          </p>
        </div>
        <div className="diary-divider" />

        {loading && <div className="diary-status">Opening the pages…</div>}
        {error && (
          <div className="diary-status error">
            Could not reach diary API ({error})
          </div>
        )}

        {!loading && !error && entries && entries.length === 0 && (
          <div className="diary-status">No entries yet.</div>
        )}

        {!loading && !error && entries && entries.length > 0 && (
          <>
            {skills.length > 0 && (
              <div
                className={`skills-box${skillsShut ? ' shut' : ''}`}
                onClick={() => setSkillsShut((s) => !s)}
              >
                <div className="skills-head">
                  ✦ Evolved skills
                  <span className="arr">▼</span>
                </div>
                <div className="sk-grid">
                  {skills.map((s, i) => (
                    <span
                      key={s.name}
                      className={`sk-item ${SKILL_COLOR_CLASSES[i % SKILL_COLOR_CLASSES.length]}`}
                    >
                      {s.name} <span className="n">+{s.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="filters">
              {(['all', 'skills', 'patterns', 'contacts'] as Filter[]).map((f) => (
                <button
                  key={f}
                  className={`fbtn${filter === f ? ' on' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>

            {filter === 'all' && (
              <>
                {groups.length > 1 && (
                  <div className="date-bar" role="tablist">
                    {groups.map((g) => (
                      <button
                        key={g.date}
                        className={`date-pill${openDays[g.date] ? ' on' : ''}`}
                        onClick={() => jumpToDate(g.date)}
                        title={`${g.entries.length} ${g.entries.length === 1 ? 'entry' : 'entries'}`}
                      >
                        {formatPillDate(g.date)}
                      </button>
                    ))}
                  </div>
                )}

                {groups.map((g) => {
                  const open = !!openDays[g.date]
                  return (
                    <div id={`dg-${g.date}`} key={g.date} className={`dg${open ? '' : ' shut'}`}>
                      <div
                        className="dg-head"
                        onClick={() =>
                          setOpenDays((prev) => ({ ...prev, [g.date]: !prev[g.date] }))
                        }
                      >
                        <span className="dg-date">{g.date}</span>
                        <span className="dg-line" />
                        <span className="dg-n">
                          {g.entries.length} {g.entries.length === 1 ? 'entry' : 'entries'}
                        </span>
                        <span className="dg-arr">▼</span>
                      </div>
                      <div className="dg-body">
                        {g.entries.map((e, idx) => (
                          <EntryView key={`${g.date}-${idx}`} entry={e} />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {filter === 'skills' && (
              <AggregateView
                kind="skill"
                title="Skill Inventory"
                items={skillAggs}
                avatarName={avatar.name}
              />
            )}
            {filter === 'patterns' && (
              <AggregateView
                kind="pattern"
                title="Pattern Inventory"
                items={patternAggs}
                avatarName={avatar.name}
              />
            )}
            {filter === 'contacts' && (
              <ContactsView items={contactAggs} avatarName={avatar.name} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function formatPillDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return date
  const [, , mm, dd] = m
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const idx = parseInt(mm, 10) - 1
  return `${months[idx] ?? mm} ${parseInt(dd, 10)}`
}

function formatTime(ts?: string): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (!Number.isNaN(d.getTime())) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  const m = ts.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : null
}

function EntryView({ entry }: { entry: ParsedEntry }) {
  const time = formatTime(entry.timestamp)
  return (
    <div className="ent">
      <div className="ent-head">
        <p className="ent-title">{entry.title}</p>
        {time && <span className="ent-time">{time}</span>}
      </div>
      <p className="ent-text">{entry.text}</p>
      {entry.tags.length > 0 && (
        <div className="ent-tags">
          <span className="tl">Tags: </span>
          {entry.tags.map((t, i) => (
            <span key={i}>
              <TagSpan tag={t} />
              {i < entry.tags.length - 1 && <span className="t-sep">,</span>}{' '}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function nodePosition(name: string, idx: number, total: number) {
  const h = hashCode(name)
  const cols = total <= 4 ? total : Math.ceil(Math.sqrt(total * 1.5))
  const col = idx % cols
  const row = Math.floor(idx / cols)
  const baseX = ((col + 0.5) / cols) * 100
  const baseY = ((row + 0.5) / Math.max(1, Math.ceil(total / cols))) * 100
  const jitterX = ((h % 1000) / 1000 - 0.5) * 12
  const jitterY = (((h >> 7) % 1000) / 1000 - 0.5) * 14
  return { left: `${Math.max(8, Math.min(92, baseX + jitterX))}%`, top: `${Math.max(12, Math.min(88, baseY + jitterY))}%` }
}

function nodeSize(count: number, max: number): number {
  if (max <= 1) return 84
  const t = count / max
  return Math.round(60 + t * 84)
}

function AggregateView({
  kind,
  title,
  items,
  avatarName,
}: {
  kind: 'skill' | 'pattern'
  title: string
  items: TagAggregate[]
  avatarName: string
}) {
  if (items.length === 0) {
    return <div className="diary-status">No {kind === 'skill' ? 'skills' : 'patterns'} yet.</div>
  }
  const max = Math.max(...items.map((i) => i.count))
  const dotClass = kind === 'skill' ? 'dot-skill' : 'dot-pattern'

  return (
    <>
      <div className="agg-graph">
        {items.map((item, i) => {
          const pos = nodePosition(item.name, i, items.length)
          const size = nodeSize(item.count, max)
          return (
            <div
              key={item.name}
              className={`agg-node ${dotClass}`}
              style={{ left: pos.left, top: pos.top, width: size, height: size }}
            >
              <span className="agg-node-name">{item.displayName}</span>
              <span className="agg-node-count">
                {item.count} {item.count === 1 ? 'reference' : 'references'}
              </span>
            </div>
          )
        })}
      </div>

      <div className="agg-section-head">{title}</div>
      <div className="agg-list">
        {items.map((item) => (
          <div key={item.name} className="agg-card">
            <span className={`agg-card-dot ${dotClass}`} />
            <div className="agg-card-body">
              <div className="agg-card-title">{item.displayName}</div>
              {item.description && (
                <div className="agg-card-desc">{item.description}</div>
              )}
              <div className="agg-card-meta">{avatarName}</div>
            </div>
            <div className="agg-card-side">
              <div className="agg-card-count">
                {item.count} {item.count === 1 ? 'entry' : 'entries'}
              </div>
              <div className="agg-card-since">Since {item.since}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function ContactsView({
  items,
  avatarName,
}: {
  items: TagAggregate[]
  avatarName: string
}) {
  if (items.length === 0) {
    return <div className="diary-status">No contacts referenced yet.</div>
  }
  return (
    <>
      <div className="agg-section-head">Contact Inventory</div>
      <div className="agg-list">
        {items.map((item) => (
          <div key={item.name} className="agg-card contact-card">
            <span className="agg-card-dot dot-contact" />
            <div className="agg-card-body">
              <div className="agg-card-title">{item.displayName}</div>
              <div className="agg-card-desc">
                Last entry: <em>{item.recentTitles[0] ?? '—'}</em>
              </div>
              {item.recentTitles.length > 1 && (
                <ul className="contact-titles">
                  {item.recentTitles.slice(1).map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              )}
              <div className="agg-card-meta">{avatarName}</div>
            </div>
            <div className="agg-card-side">
              <div className="agg-card-count">
                {item.count} {item.count === 1 ? 'entry' : 'entries'}
              </div>
              <div className="agg-card-since">Last {item.latestDate}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function TagSpan({ tag }: { tag: ParsedTag }) {
  const cls =
    tag.type === 'skill'
      ? 't-sk'
      : tag.type === 'pattern'
        ? 't-pa'
        : tag.type === 'contact'
          ? 't-co'
          : 't-ot'
  return <span className={cls}>{tag.raw}</span>
}
