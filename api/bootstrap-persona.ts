import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'

const JUAN_VOICE_ID = 'lx8LAX2EUAKftVz0Dk5z'

function getDatabaseUrl() {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ''
  )
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const databaseUrl = getDatabaseUrl()
  if (!databaseUrl) {
    return res.status(500).json({ error: 'Missing database connection string' })
  }

  const avatarSoulPath = path.join(process.cwd(), 'AVATAR_SOUL.md')
  const systemPrompt = await readFile(avatarSoulPath, 'utf8')
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })

  try {
    await client.connect()
    await client.query('ALTER TABLE public.wa_owners ADD COLUMN IF NOT EXISTS system_prompt TEXT')
    const result = await client.query(
      `
        UPDATE public.wa_owners
        SET system_prompt = $1,
            voice_id = COALESCE(voice_id, $2),
            updated_at = NOW()
        WHERE (voice_id = $2
           OR display_name = 'Juan Schubert'
           OR display_name = 'Juan')
          AND deleted_at IS NULL
        RETURNING id, display_name, voice_id
      `,
      [systemPrompt, JUAN_VOICE_ID]
    )

    if (result.rowCount === 0) {
      const inserted = await client.query(
        `
          INSERT INTO public.wa_owners (display_name, voice_id, system_prompt)
          VALUES ('Juan Schubert', $1, $2)
          RETURNING id, display_name, voice_id
        `,
        [JUAN_VOICE_ID, systemPrompt]
      )
      return res.status(200).json({ updated: inserted.rows })
    }

    return res.status(200).json({ updated: result.rows })
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  } finally {
    await client.end().catch(() => undefined)
  }
}
