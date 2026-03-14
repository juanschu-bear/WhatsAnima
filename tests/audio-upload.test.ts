import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''

describe('Audio Upload to Supabase Storage', () => {
  it('should upload an audio blob and return a public URL', async () => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.warn('Skipping: SUPABASE_URL or key not set')
      return
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // Create a minimal valid audio blob (silent WAV: 44-byte header + 0 data)
    const header = new ArrayBuffer(44)
    const view = new DataView(header)
    // RIFF header
    const te = new TextEncoder()
    const riff = te.encode('RIFF')
    new Uint8Array(header).set(riff, 0)
    view.setUint32(4, 36, true) // file size - 8
    new Uint8Array(header).set(te.encode('WAVE'), 8)
    new Uint8Array(header).set(te.encode('fmt '), 12)
    view.setUint32(16, 16, true) // subchunk size
    view.setUint16(20, 1, true)  // PCM
    view.setUint16(22, 1, true)  // mono
    view.setUint32(24, 8000, true) // sample rate
    view.setUint32(28, 8000, true) // byte rate
    view.setUint16(32, 1, true)  // block align
    view.setUint16(34, 8, true)  // bits per sample
    new Uint8Array(header).set(te.encode('data'), 36)
    view.setUint32(40, 0, true)  // data size

    const testPath = `test/audio-upload-test-${Date.now()}.wav`
    const blob = new Blob([header], { type: 'audio/wav' })

    const { error: uploadError } = await supabase.storage
      .from('voice-messages')
      .upload(testPath, blob, { contentType: 'audio/wav', upsert: true })

    expect(uploadError).toBeNull()

    const { data } = supabase.storage.from('voice-messages').getPublicUrl(testPath)
    expect(data.publicUrl).toBeTruthy()
    expect(data.publicUrl).toContain('voice-messages')

    // Cleanup
    await supabase.storage.from('voice-messages').remove([testPath])
  })
})
