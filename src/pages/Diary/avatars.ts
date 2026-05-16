export interface DiaryAvatar {
  name: string
  initials: string
  expertise: string
  wing: string
  number: string
  agentId: string
  type: 'Elite' | 'Premium'
}

export const DIARY_AVATARS: DiaryAvatar[] = [
  {
    number: '01',
    wing: 'WING I',
    name: 'Trace Flores',
    initials: 'TF',
    expertise: 'Business Strategist & Pattern Architect',
    agentId: 'trace-flores',
    type: 'Elite',
  },
  {
    number: '02',
    wing: 'WING II',
    name: 'Juan Schubert',
    initials: 'JS',
    expertise: 'System Architect & Digital Twin',
    agentId: 'juan-schubert',
    type: 'Premium',
  },
  {
    number: '03',
    wing: 'WING III',
    name: 'Adri Kastel',
    initials: 'AK',
    expertise: 'Growth Expert & Scaling Mentor',
    agentId: 'adri-kastel',
    type: 'Premium',
  },
  {
    number: '04',
    wing: 'WING IV',
    name: 'Prof. Ryan Cox',
    initials: 'BC',
    expertise: 'Science Communicator & Educator',
    agentId: 'prof.-brian-cox',
    type: 'Premium',
  },
  {
    number: '05',
    wing: 'WING V',
    name: 'Clara Fontaine',
    initials: 'CF',
    expertise: 'Executive Communication Coach',
    agentId: 'clara-fontaine',
    type: 'Elite',
  },
  {
    number: '06',
    wing: 'WING VI',
    name: 'Elena Navarro',
    initials: 'EN',
    expertise: 'Sales Strategist & Business Growth Expert',
    agentId: 'elena-navarro',
    type: 'Premium',
  },
  {
    number: '07',
    wing: 'WING VII',
    name: 'Jordan Cash',
    initials: 'JC',
    expertise: 'Cash Flow & Finance Strategist',
    agentId: 'jordan-cash',
    type: 'Premium',
  },
]

export const AVATARS_BY_ID: Record<string, DiaryAvatar> = Object.fromEntries(
  DIARY_AVATARS.map((a) => [a.agentId, a]),
)

function initialsFrom(name: string): string {
  const parts = name.replace(/^Prof\.?\s+/i, '').split(/\s+/).filter(Boolean)
  return (parts[0]?.[0] ?? '').toUpperCase() + (parts[1]?.[0] ?? '').toUpperCase()
}

export function avatarFromApi(api: {
  agent_id: string
  name?: string
  initials?: string
  expertise?: string
  role?: string
  wing?: string
  number?: string
  type?: string
}): DiaryAvatar {
  const base = AVATARS_BY_ID[api.agent_id]
  if (base) return base
  const name = api.name ?? api.agent_id
  return {
    agentId: api.agent_id,
    name,
    initials: api.initials ?? initialsFrom(name),
    expertise: api.expertise ?? api.role ?? '',
    wing: api.wing ?? '',
    number: api.number ?? '',
    type: api.type === 'Elite' ? 'Elite' : 'Premium',
  }
}
