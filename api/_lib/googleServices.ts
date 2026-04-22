import { google } from 'googleapis'
import type { drive_v3, sheets_v4 } from 'googleapis'
import { Readable } from 'node:stream'
import type { ExtractedReceipt } from './receiptExtraction.js'

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
]

const CFO_SHEET_TAB = 'Transactions'
const CFO_SHEET_RANGE = `${CFO_SHEET_TAB}!A:K`

export interface DriveUploadResult {
  url: string | null
  fileId: string | null
  error: string | null
}

export interface SheetsAppendResult {
  rowIndex: number | null
  error: string | null
}

export interface ReceiptSheetRow {
  transactionDate: string | null
  merchant: string | null
  totalAmount: number | null
  currency: string
  vatAmount: number | null
  category: string
  isBusinessExpense: boolean
  taxRelevant: boolean
  paymentMethod: string | null
  freeTags: string[]
  driveUrl: string | null
  whatsanimaUrl: string | null
}

interface ServiceAccountJson {
  client_email: string
  private_key: string
  [key: string]: unknown
}

let cachedClients:
  | { drive: drive_v3.Drive; sheets: sheets_v4.Sheets }
  | null = null
let cachedClientsError: Error | null = null

function parseServiceAccount(raw: string): ServiceAccountJson {
  const parsed = JSON.parse(raw) as ServiceAccountJson
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('service account JSON missing client_email or private_key')
  }
  // Env vars often double-escape newlines in the private key — normalize.
  parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
  return parsed
}

function getClients() {
  if (cachedClients) return cachedClients
  if (cachedClientsError) throw cachedClientsError
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) {
    cachedClientsError = new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
    throw cachedClientsError
  }
  try {
    const sa = parseServiceAccount(raw)
    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: DRIVE_SCOPES,
    })
    cachedClients = {
      drive: google.drive({ version: 'v3', auth }),
      sheets: google.sheets({ version: 'v4', auth }),
    }
    return cachedClients
  } catch (err) {
    cachedClientsError = err instanceof Error ? err : new Error(String(err))
    throw cachedClientsError
  }
}

function sanitizeFilenameSegment(input: string | null | undefined, fallback: string): string {
  const raw = (input ?? '').trim() || fallback
  return raw.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || fallback
}

function extensionFromMime(mime: string | undefined | null, urlHint: string): string {
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/pdf': 'pdf',
  }
  if (mime && mimeMap[mime.toLowerCase()]) return mimeMap[mime.toLowerCase()]
  const urlExt = urlHint.split('?')[0].split('.').pop()?.toLowerCase() || ''
  if (urlExt && urlExt.length <= 5 && /^[a-z0-9]+$/.test(urlExt)) return urlExt
  return 'jpg'
}

async function findOrCreateFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<string> {
  const escaped = name.replace(/'/g, "\\'")
  const query = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  const list = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  const existing = list.data.files?.[0]?.id
  if (existing) return existing
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  })
  if (!created.data.id) throw new Error(`failed to create folder '${name}'`)
  return created.data.id
}

function monthlyFolderSegments(date: Date): { year: string; month: string } {
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
  }
}

function buildFilename(
  receipt: Pick<ExtractedReceipt, 'transaction_date' | 'merchant' | 'total_amount' | 'currency'>,
  ext: string,
): string {
  const date = receipt.transaction_date ?? new Date().toISOString().slice(0, 10)
  const merchant = sanitizeFilenameSegment(receipt.merchant, 'receipt')
  const amount =
    receipt.total_amount != null && Number.isFinite(receipt.total_amount)
      ? receipt.total_amount.toFixed(2)
      : '0.00'
  const currency = (receipt.currency || 'EUR').toUpperCase()
  return `${date}_${merchant}_${amount}${currency}.${ext}`
}

export async function uploadReceiptToDrive(
  imageUrl: string,
  receipt: ExtractedReceipt,
  uploadedAt: Date = new Date(),
): Promise<DriveUploadResult> {
  const rootFolderId = process.env.GOOGLE_DRIVE_CFO_FOLDER_ID
  if (!rootFolderId) return { url: null, fileId: null, error: 'GOOGLE_DRIVE_CFO_FOLDER_ID is not set' }
  if (!imageUrl) return { url: null, fileId: null, error: 'imageUrl missing' }

  let drive: drive_v3.Drive
  try {
    drive = getClients().drive
  } catch (err) {
    return { url: null, fileId: null, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    const response = await fetch(imageUrl)
    if (!response.ok) {
      return { url: null, fileId: null, error: `fetch image ${response.status}` }
    }
    const mimeType = response.headers.get('content-type') || 'application/octet-stream'
    const buffer = Buffer.from(await response.arrayBuffer())

    const { year, month } = monthlyFolderSegments(uploadedAt)
    const yearFolderId = await findOrCreateFolder(drive, rootFolderId, year)
    const monthFolderId = await findOrCreateFolder(drive, yearFolderId, month)

    const ext = extensionFromMime(mimeType, imageUrl)
    const filename = buildFilename(receipt, ext)

    const created = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [monthFolderId],
      },
      media: {
        mimeType,
        body: Readable.from(buffer),
      },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    })

    const fileId = created.data.id ?? null
    const url = created.data.webViewLink ?? (fileId ? `https://drive.google.com/file/d/${fileId}/view` : null)
    return { url, fileId, error: null }
  } catch (err) {
    return { url: null, fileId: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function appendReceiptToSheet(row: ReceiptSheetRow): Promise<SheetsAppendResult> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_CFO_ID
  if (!spreadsheetId) return { rowIndex: null, error: 'GOOGLE_SHEETS_CFO_ID is not set' }

  let sheets: sheets_v4.Sheets
  try {
    sheets = getClients().sheets
  } catch (err) {
    return { rowIndex: null, error: err instanceof Error ? err.message : String(err) }
  }

  const values = [[
    row.transactionDate ?? '',
    row.merchant ?? '',
    row.totalAmount != null ? row.totalAmount : '',
    row.vatAmount != null ? row.vatAmount : '',
    row.category,
    row.isBusinessExpense ? 'ja' : 'nein',
    row.taxRelevant ? 'ja' : 'nein',
    row.paymentMethod ?? '',
    row.freeTags.join(', '),
    row.driveUrl ?? '',
    row.whatsanimaUrl ?? '',
  ]]

  try {
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: CFO_SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
    const updatedRange = result.data.updates?.updatedRange || ''
    // updatedRange looks like "Transactions!A42:K42" — extract the row number.
    const rowMatch = updatedRange.match(/![A-Z]+(\d+):/)
    const rowIndex = rowMatch ? parseInt(rowMatch[1], 10) : null
    return { rowIndex, error: null }
  } catch (err) {
    return { rowIndex: null, error: err instanceof Error ? err.message : String(err) }
  }
}
