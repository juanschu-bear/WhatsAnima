import { createClient } from '@supabase/supabase-js'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_AI_TOKEN
  if (!accountId || !apiToken) {
    return res.status(500).json({ error: 'Cloudflare AI not configured' })
  }

  const { prompt, conversation_id } = req.body
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing prompt' })
  }

  try {
    // Call Cloudflare Workers AI — FLUX.2 [dev]
    const formData = new FormData()
    formData.append('prompt', prompt)
    formData.append('steps', '25')
    formData.append('width', '1024')
    formData.append('height', '1024')

    const cfResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-2-dev`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
        body: formData,
      }
    )

    if (!cfResponse.ok) {
      const errText = await cfResponse.text()
      console.error('[generate-image] Cloudflare error:', cfResponse.status, errText)
      return res.status(502).json({ error: 'Image generation failed' })
    }

    // Response is raw PNG bytes
    const imageBuffer = Buffer.from(await cfResponse.arrayBuffer())

    // Upload to Supabase Storage
    const supabase = getSupabaseAdmin()
    const filename = `generated/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`

    const { error: uploadError } = await supabase.storage
      .from('media')
      .upload(filename, imageBuffer, {
        contentType: 'image/png',
        upsert: false,
      })

    if (uploadError) {
      console.error('[generate-image] Upload error:', uploadError)
      return res.status(500).json({ error: 'Failed to store image' })
    }

    const { data: urlData } = supabase.storage
      .from('media')
      .getPublicUrl(filename)

    // If conversation_id provided, store as a message
    if (conversation_id) {
      await supabase.from('wa_messages').insert({
        conversation_id,
        sender: 'avatar',
        type: 'image',
        content: prompt,
        media_url: urlData.publicUrl,
      })
    }

    return res.status(200).json({
      url: urlData.publicUrl,
      prompt,
    })
  } catch (err: any) {
    console.error('[generate-image] Error:', err)
    return res.status(500).json({ error: err.message || 'Internal error' })
  }
}
