import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY

  if (!supabaseUrl || !supabaseKey) return null
  return createClient(supabaseUrl, supabaseKey)
}

function ffmpegAvailable() {
  return new Promise<boolean>((resolve) => {
    execFile('ffmpeg', ['-version'], (error) => resolve(!error))
  })
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

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabase = getSupabaseAdminClient()
  if (!supabase) {
    return res.status(503).json({ error: 'Storage not configured' })
  }

  const { media_base64, owner_id, conversation_id, mime_type, media_type } = req.body ?? {}
  const preferredBucket = media_type === 'image' ? 'image-uploads' : 'voice-messages'
  const fallbackBucket = 'voice-messages'

  if (!media_base64 || !owner_id || !conversation_id) {
    return res.status(400).json({ error: 'Missing required fields: media_base64, owner_id, conversation_id' })
  }

  try {
    let buffer = Buffer.from(media_base64, 'base64')

    if (media_type === 'video') {
      const mimeExt = String(mime_type || '').includes('quicktime')
        ? 'mov'
        : String(mime_type || '').includes('mp4')
          ? 'mp4'
          : String(mime_type || '').includes('webm')
            ? 'webm'
            : 'mp4'
      try {
        const result = await autoRotateVideo(buffer, mimeExt)
        if (result.rotated) {
          console.log('[UploadMedia] EXIF auto-rotation applied, size:', buffer.length, '->', result.buffer.length)
          buffer = result.buffer
        }
      } catch (error) {
        console.warn('[UploadMedia] Auto-rotation failed, using original:', error instanceof Error ? error.message : error)
      }
    }

    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/x-matroska': 'mkv',
    }

    const ext = mimeMap[mime_type] || (media_type === 'video' ? 'mp4' : 'jpg')
    const contentType = mime_type || (media_type === 'video' ? 'video/mp4' : 'image/jpeg')
    const bucketsToTry = preferredBucket === fallbackBucket ? [preferredBucket] : [preferredBucket, fallbackBucket]

    for (const bucket of bucketsToTry) {
      const prefix = bucket === fallbackBucket && media_type === 'image' ? 'images/' : ''
      const fileName = `${prefix}${owner_id}/${conversation_id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`

      if (bucket === preferredBucket) {
        const { error: bucketError } = await supabase.storage.createBucket(bucket, {
          public: true,
          fileSizeLimit: 500 * 1024 * 1024,
        })
        if (bucketError && !bucketError.message.includes('already exists')) {
          console.warn('[UploadMedia] createBucket failed for', bucket, ':', bucketError.message)
        }
      }

      console.log('[UploadMedia] Trying bucket:', bucket, 'file:', fileName, 'size:', buffer.length, 'type:', contentType)

      const { error } = await supabase.storage
        .from(bucket)
        .upload(fileName, buffer, { contentType, upsert: false })

      if (error) {
        console.warn('[UploadMedia] Upload failed on bucket', bucket, ':', error.message)
        continue
      }

      const { data } = supabase.storage.from(bucket).getPublicUrl(fileName)
      console.log('[UploadMedia] Success on bucket', bucket, ':', data.publicUrl)
      return res.status(200).json({ url: data.publicUrl })
    }

    console.error('[UploadMedia] All upload attempts failed')
    return res.status(500).json({ error: 'Upload failed: all storage buckets rejected the file' })
  } catch (error) {
    console.error('[UploadMedia] Error:', error instanceof Error ? error.message : error)
    return res.status(500).json({
      error: 'Upload failed: ' + (error instanceof Error ? error.message : 'Unknown error'),
    })
  }
}
