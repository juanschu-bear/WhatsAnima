import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

function ffmpegAvailable() {
  return new Promise<boolean>((resolve) => {
    execFile('ffmpeg', ['-version'], (error) => resolve(!error))
  })
}

async function rotateVideo(inputBuffer: Buffer, degrees: number, inputExt = 'mp4') {
  const hasFfmpeg = await ffmpegAvailable()
  if (!hasFfmpeg) return { buffer: inputBuffer, rotated: false }

  const transposeArgs =
    degrees === 90 ? ['transpose=1'] :
    degrees === 180 ? ['transpose=1,transpose=1'] :
    degrees === 270 ? ['transpose=2'] :
    []

  if (transposeArgs.length === 0) return { buffer: inputBuffer, rotated: false }

  const tmpDir = os.tmpdir()
  const id = crypto.randomBytes(8).toString('hex')
  const inputPath = path.join(tmpDir, `whatsanima-rotate-in-${id}.${inputExt}`)
  const outputPath = path.join(tmpDir, `whatsanima-rotate-out-${id}.mp4`)

  try {
    fs.writeFileSync(inputPath, inputBuffer)
    await new Promise<void>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-y', '-i', inputPath, '-vf', transposeArgs.join(','), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath],
        { timeout: 30000 },
        (error) => (error ? reject(error) : resolve())
      )
    })
    return { buffer: fs.readFileSync(outputPath), rotated: true }
  } finally {
    try { fs.unlinkSync(inputPath) } catch {}
    try { fs.unlinkSync(outputPath) } catch {}
  }
}

async function autoRotateVideo(inputBuffer: Buffer, inputExt = 'mp4') {
  const hasFfmpeg = await ffmpegAvailable()
  if (!hasFfmpeg) return { buffer: inputBuffer, rotated: false }

  const tmpDir = os.tmpdir()
  const id = crypto.randomBytes(8).toString('hex')
  const inputPath = path.join(tmpDir, `whatsanima-autorot-in-${id}.${inputExt}`)
  const outputPath = path.join(tmpDir, `whatsanima-autorot-out-${id}.mp4`)

  try {
    fs.writeFileSync(inputPath, inputBuffer)

    const rotation = await new Promise<number>((resolve) => {
      execFile(
        'ffprobe',
        [
          '-v',
          'quiet',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream_side_data=rotation:stream_tags=rotate',
          '-of',
          'json',
          inputPath,
        ],
        { timeout: 10000 },
        (error, stdout) => {
          if (error) {
            resolve(0)
            return
          }
          try {
            const probe = JSON.parse(stdout)
            const stream = (probe.streams || [])[0] || {}
            const sideData = (stream.side_data_list || []).find((entry: any) => entry.rotation != null)
            if (sideData) {
              resolve(Math.abs(Number(sideData.rotation)))
              return
            }
            const tagRotate = (stream.tags || {}).rotate
            resolve(tagRotate ? Math.abs(Number(tagRotate)) : 0)
          } catch {
            resolve(0)
          }
        }
      )
    })

    if (!rotation || rotation === 360) {
      return { buffer: inputBuffer, rotated: false }
    }

    await new Promise<void>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-y', '-i', inputPath, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-metadata:s:v', 'rotate=0', outputPath],
        { timeout: 30000 },
        (error) => (error ? reject(error) : resolve())
      )
    })

    return { buffer: fs.readFileSync(outputPath), rotated: true }
  } finally {
    try { fs.unlinkSync(inputPath) } catch {}
    try { fs.unlinkSync(outputPath) } catch {}
  }
}

function parseMultipart(rawBody: Buffer, contentType: string) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/)
  if (!boundaryMatch) throw new Error('No boundary in content-type')
  const boundary = boundaryMatch[1] || boundaryMatch[2]
  const boundaryBuf = Buffer.from('--' + boundary)

  const parts: Array<{
    name: string | null
    filename: string | null
    contentType: string | null
    data: Buffer
  }> = []
  let start = 0
  const positions: number[] = []

  while (true) {
    const idx = rawBody.indexOf(boundaryBuf, start)
    if (idx === -1) break
    positions.push(idx)
    start = idx + boundaryBuf.length
  }

  for (let i = 0; i < positions.length - 1; i += 1) {
    const partStart = positions[i] + boundaryBuf.length
    const partEnd = positions[i + 1]
    const partBuf = rawBody.slice(partStart, partEnd)
    let offset = 0
    if (partBuf[0] === 0x0d && partBuf[1] === 0x0a) offset = 2
    const sepIdx = partBuf.indexOf('\r\n\r\n', offset)
    if (sepIdx === -1) continue

    const headerStr = partBuf.slice(offset, sepIdx).toString('utf8')
    let body = partBuf.slice(sepIdx + 4)
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.slice(0, body.length - 2)
    }

    const nameMatch = headerStr.match(/name="([^"]+)"/)
    const filenameMatch = headerStr.match(/filename="([^"]+)"/)
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i)

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: ctMatch ? ctMatch[1].trim() : null,
      data: body,
    })
  }

  const fields: Record<string, string> = {}
  const files: Record<string, { filename: string | null; contentType: string | null; buffer: Buffer }> = {}
  for (const part of parts) {
    if (!part.name) continue
    if (part.filename) {
      files[part.name] = {
        filename: part.filename,
        contentType: part.contentType,
        buffer: part.data,
      }
    } else {
      fields[part.name] = part.data.toString('utf8')
    }
  }

  return { fields, files }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const opmUrl = process.env.OPM_API_URL
  if (!opmUrl) {
    return res.status(503).json({ error: 'OPM_API_URL not configured — use direct upload or mock mode' })
  }

  if (!req.rawBody) {
    return res.status(400).json({ error: 'Expected multipart/form-data with rawBody' })
  }

  let fields: Record<string, string>
  let files: Record<string, { filename: string | null; contentType: string | null; buffer: Buffer }>
  try {
    const parsed = parseMultipart(req.rawBody, req.headers['content-type'])
    fields = parsed.fields
    files = parsed.files
  } catch (error) {
    return res.status(400).json({ error: 'Failed to parse multipart body: ' + (error instanceof Error ? error.message : 'Unknown error') })
  }

  const videoFile = files.video
  if (!videoFile) {
    return res.status(400).json({ error: 'Missing video file' })
  }

  const userId = fields.user_id
  const preset = fields.preset || 'celebrity_ceo'
  const orientation = fields.orientation

  let videoBuffer = videoFile.buffer
  let wasRotated = false
  const ext =
    (videoFile.contentType || '').includes('mp4') ? 'mp4' :
    (videoFile.contentType || '').includes('webm') ? 'webm' :
    (videoFile.contentType || '').includes('quicktime') ? 'mov' :
    'mp4'

  if (orientation && Number(orientation) !== 0) {
    try {
      const result = await rotateVideo(videoBuffer, Number(orientation), ext)
      videoBuffer = result.buffer
      wasRotated = result.rotated
    } catch {}
  }

  if (!wasRotated && (!orientation || Number(orientation) === 0)) {
    try {
      const result = await autoRotateVideo(videoBuffer, ext)
      videoBuffer = result.buffer
      wasRotated = result.rotated
    } catch {}
  }

  try {
    const boundary = '----AnimaIngest' + Date.now()
    const parts: Array<string | Buffer> = []
    const videoFilename = videoFile.filename || ('capture.' + ((videoFile.contentType || '').includes('mp4') ? 'mp4' : 'webm'))
    const videoContentType = videoFile.contentType || 'video/mp4'

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="video"; filename="${videoFilename}"\r\n` +
      `Content-Type: ${videoContentType}\r\n\r\n`
    )
    parts.push(videoBuffer)
    parts.push('\r\n')

    if (userId) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="user_id"\r\n\r\n` +
        `${userId}\r\n`
      )
    }

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="preset"\r\n\r\n` +
      `${preset}\r\n`
    )

    if (orientation && !wasRotated) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="orientation"\r\n\r\n` +
        `${orientation}\r\n`
      )
    }

    parts.push(`--${boundary}--\r\n`)

    const bodyParts = parts.map((part) => typeof part === 'string' ? Buffer.from(part) : part)
    const requestBody = Buffer.concat(bodyParts)

    const opmRes = await fetch(`${opmUrl}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: requestBody,
    })

    const opmData = await opmRes.json()
    if (!opmRes.ok) {
      return res.status(opmRes.status).json(opmData)
    }

    return res.status(200).json({
      ...opmData,
      _orientation_applied: wasRotated,
    })
  } catch (error) {
    return res.status(502).json({ error: 'Failed to forward to OPM: ' + (error instanceof Error ? error.message : 'Unknown error') })
  }
}
