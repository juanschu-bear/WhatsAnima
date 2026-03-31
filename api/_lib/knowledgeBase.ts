import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let cachedKnowledge: string | null = null

/**
 * Load all .md files from api/knowledge/ and return their concatenated content.
 * Cached in memory — only read from disk once per serverless cold start.
 */
export function getKnowledgeBaseContent(): string {
  if (cachedKnowledge !== null) return cachedKnowledge

  // Vercel serverless runs in ESM mode where __dirname is not defined.
  // Use process.cwd() which points to the project root in Vercel.
  const knowledgeDir = join(process.cwd(), 'api', 'knowledge')
  let combined = ''

  try {
    const files = readdirSync(knowledgeDir)
      .filter((f) => f.endsWith('.md'))
      .sort()

    for (const file of files) {
      const content = readFileSync(join(knowledgeDir, file), 'utf-8').trim()
      if (content && !content.startsWith('<!-- Replace this placeholder')) {
        combined += content + '\n\n'
      }
    }
  } catch (err) {
    console.warn('[knowledge] Failed to load knowledge base files:', err instanceof Error ? err.message : err)
  }

  cachedKnowledge = combined.trim()
  if (cachedKnowledge) {
    console.log(`[knowledge] Loaded ${cachedKnowledge.length} chars of knowledge base content`)
  }
  return cachedKnowledge
}
