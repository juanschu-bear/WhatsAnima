/**
 * CFO category taxonomy — single source of truth.
 *
 * Used by:
 *   - api/_lib/receiptExtraction.ts   (to constrain the GPT Vision prompt)
 *   - api/chat.ts                     (to validate the model's category choice
 *                                      before writing to cfo_transactions)
 *
 * Contract with the model:
 *   - Pick exactly one `key` from CFO_CATEGORIES.
 *   - If nothing fits, pick 'sonstiges' AND return up to 3 free_tags.
 *   - free_tags MUST be empty for any key other than 'sonstiges'.
 */

export interface CfoCategory {
  key: string
  description: string
}

export const CFO_CATEGORIES = [
  { key: 'software_abos',        description: 'SaaS subscriptions (Notion, Figma, GitHub, etc.)' },
  { key: 'ai_abos',              description: 'AI tools specifically (ChatGPT, Claude, Cursor, Midjourney, Runway, ElevenLabs, OpenAI API, Anthropic API, etc.)' },
  { key: 'geschaeftsessen',      description: 'Business meals, client dinners' },
  { key: 'reisen',               description: 'Travel, hotels, flights, trains' },
  { key: 'marketing',            description: 'Ads, content, branding spend' },
  { key: 'bueromaterial',        description: 'Office supplies, small consumables' },
  { key: 'hardware',             description: 'Laptops, phones, peripherals, durable goods' },
  { key: 'lebensmittel',         description: 'Groceries' },
  { key: 'restaurant_privat',    description: 'Restaurants (private, not business)' },
  { key: 'transport',            description: 'Fuel, parking, public transport, rideshare' },
  { key: 'wohnen',               description: 'Rent, utilities, home-related recurring' },
  { key: 'gesundheit',           description: 'Pharmacy, doctor, medical insurance' },
  { key: 'koerperpflege',        description: 'Toiletries, cosmetics, haircare' },
  { key: 'unterhaltung',         description: 'Entertainment, media, events' },
  { key: 'steuer_versicherung',  description: 'Taxes, non-medical insurance premiums, fees' },
  { key: 'sonstiges',            description: 'None of the above — MUST be returned with 1–3 free_tags' },
] as const satisfies readonly CfoCategory[]

export type CfoCategoryKey = typeof CFO_CATEGORIES[number]['key']

export const CFO_CATEGORY_KEYS: readonly CfoCategoryKey[] =
  CFO_CATEGORIES.map((c) => c.key) as readonly CfoCategoryKey[]

export function isCfoCategory(value: unknown): value is CfoCategoryKey {
  return typeof value === 'string' && (CFO_CATEGORY_KEYS as readonly string[]).includes(value)
}
