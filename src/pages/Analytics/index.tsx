import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import './analytics.css'

interface UserRow {
  user_id: string
  email: string
  display_name: string
  last_active_at: string
  total_calls: number
  total_messages_sent: number
  pwa_installed: boolean
  device_type: string
}

interface AvatarStat {
  name: string
  sessions: number
  minutes: number
}

interface DailyCount {
  date: string
  count: number
}

export default function Analytics() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [users, setUsers] = useState<UserRow[]>([])
  const [avatarStats, setAvatarStats] = useState<AvatarStat[]>([])
  const [dailyCalls, setDailyCalls] = useState<DailyCount[]>([])
  const [totals, setTotals] = useState({
    totalUsers: 0,
    activeThisWeek: 0,
    totalCalls: 0,
    totalMinutes: 0,
    totalMessages: 0,
    pwaInstalls: 0,
    avgCallDuration: 0,
  })

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      // Load user profiles
      const { data: profiles } = await supabase
        .from('wa_user_profiles')
        .select('*')
        .order('last_active_at', { ascending: false })

      // Load session summaries for avatar stats
      const { data: summaries } = await supabase
        .from('wa_session_summaries')
        .select('avatar_name, call_duration_seconds, created_at, user_name')
        .not('call_duration_seconds', 'is', null)
        .order('created_at', { ascending: false })
        .limit(500)

      // Load recent analytics events
      const { data: events } = await supabase
        .from('wa_analytics')
        .select('event_type, created_at, user_id')
        .order('created_at', { ascending: false })
        .limit(1000)

      // Process user profiles
      const userRows: UserRow[] = (profiles || []).map((p: any) => ({
        user_id: p.user_id,
        email: p.email || '',
        display_name: p.display_name || p.email?.split('@')[0] || 'Unknown',
        last_active_at: p.last_active_at || '',
        total_calls: p.total_calls || 0,
        total_messages_sent: p.total_messages_sent || 0,
        pwa_installed: p.pwa_installed || false,
        device_type: p.device_type || 'unknown',
      }))

      // Also get users from wa_contacts who don't have profiles yet
      const { data: contacts } = await supabase
        .from('wa_contacts')
        .select('email, display_name, last_active_at')
        .not('email', 'is', null)
        .order('last_active_at', { ascending: false })

      const existingEmails = new Set(userRows.map(u => u.email))
      const contactUsers: UserRow[] = []
      const seenEmails = new Set<string>()
      for (const c of (contacts || [])) {
        const email = c.email || ''
        if (email && !existingEmails.has(email) && !seenEmails.has(email)) {
          seenEmails.add(email)
          contactUsers.push({
            user_id: '',
            email,
            display_name: c.display_name || email.split('@')[0],
            last_active_at: c.last_active_at || '',
            total_calls: 0,
            total_messages_sent: 0,
            pwa_installed: false,
            device_type: 'unknown',
          })
        }
      }

      const allUsers = [...userRows, ...contactUsers]

      // Process avatar stats
      const avatarMap = new Map<string, { sessions: number; minutes: number }>()
      for (const s of (summaries || [])) {
        const name = s.avatar_name || 'Unknown'
        const prev = avatarMap.get(name) || { sessions: 0, minutes: 0 }
        prev.sessions += 1
        prev.minutes += Math.round((s.call_duration_seconds || 0) / 60)
        avatarMap.set(name, prev)
      }
      const avatars: AvatarStat[] = Array.from(avatarMap.entries())
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.sessions - a.sessions)

      // Process daily calls (last 14 days)
      const dayMap = new Map<string, number>()
      const now = new Date()
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now)
        d.setDate(d.getDate() - i)
        dayMap.set(d.toISOString().slice(0, 10), 0)
      }
      for (const s of (summaries || [])) {
        const day = (s.created_at || '').slice(0, 10)
        if (dayMap.has(day)) dayMap.set(day, (dayMap.get(day) || 0) + 1)
      }
      const daily: DailyCount[] = Array.from(dayMap.entries()).map(([date, count]) => ({ date, count }))

      // Calculate totals
      const totalCalls = (summaries || []).length
      const totalMinutes = (summaries || []).reduce((sum: number, s: any) => sum + Math.round((s.call_duration_seconds || 0) / 60), 0)
      const avgDuration = totalCalls > 0 ? Math.round((summaries || []).reduce((sum: number, s: any) => sum + (s.call_duration_seconds || 0), 0) / totalCalls) : 0

      const oneWeekAgo = new Date()
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
      const activeThisWeek = new Set(
        (events || []).filter((e: any) => new Date(e.created_at) > oneWeekAgo).map((e: any) => e.user_id)
      ).size

      const pwaCount = allUsers.filter(u => u.pwa_installed).length

      setUsers(allUsers)
      setAvatarStats(avatars)
      setDailyCalls(daily)
      setTotals({
        totalUsers: allUsers.length,
        activeThisWeek,
        totalCalls,
        totalMinutes,
        totalMessages: allUsers.reduce((s, u) => s + u.total_messages_sent, 0),
        pwaInstalls: pwaCount,
        avgCallDuration: avgDuration,
      })
    } catch (err) {
      console.error('[Analytics] Load failed:', err)
    } finally {
      setLoading(false)
    }
  }

  const maxDaily = Math.max(...dailyCalls.map(d => d.count), 1)
  const maxAvatarSessions = Math.max(...avatarStats.map(a => a.sessions), 1)

  function timeAgo(iso: string): string {
    if (!iso) return 'never'
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  if (loading) {
    return (
      <div className="analytics-root">
        <div className="an-page">
          <div className="an-loading"><div className="an-spinner" />Loading analytics...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="analytics-root">
      <div className="an-page">
        <button className="an-back" onClick={() => navigate('/')}>&#8592; Home</button>

        <div className="an-header an-fade-in">
          <div className="an-header-top">
            <div>
              <div className="an-title">Analytics</div>
              <div className="an-subtitle">WhatsAnima Platform Intelligence</div>
            </div>
            <div className="an-live-dot">Live</div>
          </div>
        </div>

        {/* Metric Cards */}
        <div className="an-metrics">
          <div className="an-metric an-fade-in an-stagger-1">
            <div className="an-metric-label">Total Users</div>
            <div className="an-metric-value">{totals.totalUsers}</div>
          </div>
          <div className="an-metric an-fade-in an-stagger-2">
            <div className="an-metric-label">Active This Week</div>
            <div className="an-metric-value">{totals.activeThisWeek}</div>
          </div>
          <div className="an-metric an-fade-in an-stagger-3">
            <div className="an-metric-label">Total Calls</div>
            <div className="an-metric-value">{totals.totalCalls}</div>
          </div>
          <div className="an-metric an-fade-in an-stagger-4">
            <div className="an-metric-label">Total Minutes</div>
            <div className="an-metric-value">{totals.totalMinutes}</div>
          </div>
          <div className="an-metric an-fade-in an-stagger-5">
            <div className="an-metric-label">Avg Call Duration</div>
            <div className="an-metric-value">{Math.floor(totals.avgCallDuration / 60)}m {totals.avgCallDuration % 60}s</div>
          </div>
          <div className="an-metric an-fade-in an-stagger-5">
            <div className="an-metric-label">PWA Installs</div>
            <div className="an-metric-value">{totals.pwaInstalls}</div>
          </div>
        </div>

        {/* Daily Calls Chart */}
        <div className="an-section an-fade-in">
          <div className="an-section-title">Call Volume</div>
          <div className="an-chart-wrap">
            <div className="an-chart-title">Calls per day (last 14 days)</div>
            <div className="an-bars">
              {dailyCalls.map((d, i) => (
                <div
                  key={d.date}
                  className="an-bar"
                  style={{ height: `${Math.max(4, (d.count / maxDaily) * 100)}%`, animationDelay: `${i * 0.03}s` }}
                  title={`${d.date}: ${d.count} calls`}
                >
                  <span className="an-bar-label">{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Avatar Distribution */}
        <div className="an-section an-fade-in">
          <div className="an-section-title">Avatar Usage</div>
          <div className="an-chart-wrap">
            <div className="an-avatar-bars">
              {avatarStats.map(a => (
                <div key={a.name} className="an-avatar-row">
                  <div className="an-avatar-name">{a.name}</div>
                  <div className="an-avatar-bar-track">
                    <div
                      className="an-avatar-bar-fill"
                      style={{ width: `${Math.max(5, (a.sessions / maxAvatarSessions) * 100)}%` }}
                    >
                      {a.sessions} calls &middot; {a.minutes}m
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* User Table */}
        <div className="an-section an-fade-in">
          <div className="an-section-title">Users</div>
          <div className="an-table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Last Active</th>
                  <th>Calls</th>
                  <th>Messages</th>
                  <th>Device</th>
                  <th>PWA</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={u.email || i}>
                    <td>
                      <div className="an-user-name">{u.display_name}</div>
                      <div className="an-user-email">{u.email}</div>
                    </td>
                    <td>{timeAgo(u.last_active_at)}</td>
                    <td>{u.total_calls}</td>
                    <td>{u.total_messages_sent}</td>
                    <td>
                      <span className="an-badge an-badge-browser">
                        {u.device_type === 'mobile_ios' ? '📱 iOS' :
                         u.device_type === 'mobile_android' ? '📱 Android' :
                         u.device_type === 'desktop' ? '💻 Desktop' :
                         u.device_type || '—'}
                      </span>
                    </td>
                    <td>
                      <span className={`an-badge ${u.pwa_installed ? 'an-badge-pwa' : 'an-badge-browser'}`}>
                        {u.pwa_installed ? '✓ Installed' : 'Browser'}
                      </span>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 40, color: 'rgba(226,234,243,0.3)' }}>No user data yet. Analytics will populate as users interact with the app.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: 48, fontSize: 10, letterSpacing: '0.2em', color: 'rgba(226,234,243,0.2)', textTransform: 'uppercase' }}>
          ONIOKO &middot; Platform Intelligence
        </div>
      </div>
    </div>
  )
}
