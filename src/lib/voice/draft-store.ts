import { openDB, type DBSchema } from 'idb'

export type VoiceDraftStatus =
  | 'pending_upload'
  | 'uploading'
  | 'uploaded'
  | 'upload_failed'
  | 'transcript_failed'

export interface VoiceDraft {
  local_id: string
  conversation_id: string
  user_id: string
  audio_blob: Blob
  mime_type: string
  duration_ms: number
  recorded_at: string
  status: VoiceDraftStatus
  transcript_interim: string | null
  transcript_final: string | null
  attempts: number
  last_error: string | null
  message_id: string | null
  owner_id?: string | null
  contact_id?: string | null
  owner_name?: string | null
  contact_name?: string | null
  audio_url?: string | null
}

interface VoiceDraftDb extends DBSchema {
  voice_drafts: {
    key: string
    value: VoiceDraft
    indexes: {
      'by-status': VoiceDraftStatus
      'by-conversation': string
    }
  }
}

const DB_NAME = 'whatsanima-voice-v2'
const STORE_NAME = 'voice_drafts'

async function getDb() {
  return openDB<VoiceDraftDb>(DB_NAME, 1, {
    upgrade(db) {
      if (db.objectStoreNames.contains(STORE_NAME)) return
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'local_id' })
      store.createIndex('by-status', 'status')
      store.createIndex('by-conversation', 'conversation_id')
    },
  })
}

function mergePatch(base: VoiceDraft, patch: Partial<VoiceDraft>): VoiceDraft {
  return { ...base, ...patch }
}

export const draftStore = {
  async save(draft: VoiceDraft): Promise<void> {
    const db = await getDb()
    await db.put(STORE_NAME, draft)
  },

  async get(local_id: string): Promise<VoiceDraft | null> {
    const db = await getDb()
    return (await db.get(STORE_NAME, local_id)) ?? null
  },

  async listPending(conversation_id: string): Promise<VoiceDraft[]> {
    const db = await getDb()
    const drafts = await db.getAllFromIndex(STORE_NAME, 'by-conversation', conversation_id)
    return drafts.filter((draft) => draft.status !== 'uploaded')
  },

  async listAllPending(): Promise<VoiceDraft[]> {
    const db = await getDb()
    const all = await db.getAll(STORE_NAME)
    return all.filter((draft) => draft.status !== 'uploaded')
  },

  async updateStatus(local_id: string, patch: Partial<VoiceDraft>): Promise<void> {
    const db = await getDb()
    const existing = await db.get(STORE_NAME, local_id)
    if (!existing) return
    await db.put(STORE_NAME, mergePatch(existing, patch))
  },

  async delete(local_id: string): Promise<void> {
    const db = await getDb()
    await db.delete(STORE_NAME, local_id)
  },
}
