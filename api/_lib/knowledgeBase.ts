import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

let cachedKnowledge: string | null = null

/**
 * Load all .md files from api/knowledge/ and return their concatenated content.
 * Cached in memory — only read from disk once per serverless cold start.
 */
export function getKnowledgeBaseContent(): string {
  if (cachedKnowledge !== null) return cachedKnowledge

  // In Vercel serverless, __dirname points to the bundled function directory.
  // The knowledge dir is a sibling: go up from _lib/ to api/, then into knowledge/.
  const candidates = [
    join(dirname(__dirname), 'knowledge'),
    join(__dirname, '..', 'knowledge'),
    join(process.cwd(), 'api', 'knowledge'),
  ]

  let combined = ''

  for (const knowledgeDir of candidates) {
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

      if (combined.trim()) break // Found and loaded files from this candidate
    } catch {
      // Try next candidate path
    }
  }

  cachedKnowledge = combined.trim()
  if (cachedKnowledge) {
    console.log(`[knowledge] Loaded ${cachedKnowledge.length} chars of knowledge base content`)
  }
  return cachedKnowledge
}
