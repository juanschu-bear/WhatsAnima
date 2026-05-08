export function normalizeCallSummaryText(content: unknown): string {
  const raw = String(content || '').trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const summaryText = String(
        (parsed.summary_text ?? parsed.summary ?? parsed.text ?? parsed.message ?? '') || '',
      ).trim()
      if (summaryText) return summaryText
    }
  } catch {
    // Non-JSON content, keep raw
  }
  return raw
}

