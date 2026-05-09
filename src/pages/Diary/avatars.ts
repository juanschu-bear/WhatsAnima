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
    name: 'Prof. Brian Cox',
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
]
