import { createClient } from '@supabase/supabase-js'

/**
 * TEMPORARY diagnostic endpoint — reproduces the wa_perception_logs INSERT
 * with known IDs to capture the exact Supabase error.
 * DELETE THIS FILE after debugging.
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' })
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Missing Supabase config' })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  // Use the same conversation/owner/contact from the 01:56 failure
  const conversationId = 'a506dc63-b7e6-44b3-94d5-be178c31c0c1'
  const contactId = '31726b3d-3bdf-4fb9-a6fc-b6d194041a44'
  const ownerId = '7ea747f5-002a-4ca2-bbb5-013bd8c13ca6'

  // Step 1: Verify all FK references exist
  const [convCheck, contactCheck, ownerCheck] = await Promise.all([
    supabase.from('wa_conversations').select('id').eq('id', conversationId).maybeSingle(),
    supabase.from('wa_contacts').select('id').eq('id', contactId).maybeSingle(),
    supabase.from('wa_owners').select('id').eq('id', ownerId).maybeSingle(),
  ])

  const fkChecks = {
    conversation_exists: !!convCheck.data,
    conversation_error: convCheck.error?.message ?? null,
    contact_exists: !!contactCheck.data,
    contact_error: contactCheck.error?.message ?? null,
    owner_exists: !!ownerCheck.data,
    owner_error: ownerCheck.error?.message ?? null,
  }

  // Step 2: Try the exact same INSERT that failed (with message_id=null to avoid FK issue)
  const { data: log, error: insertError } = await supabase
    .from('wa_perception_logs')
    .insert({
      message_id: null,
      conversation_id: conversationId,
      contact_id: contactId,
      owner_id: ownerId,
      transcript: '__debug_test__',
      audio_duration_sec: 5,
      primary_emotion: 'reflective',
      secondary_emotion: null,
      fired_rules: [],
      behavioral_summary: 'Debug test: reproducing the 500 error from 01:56 UTC March 29 to capture the exact Supabase error message.',
      conversation_hooks: ['test hook 1', 'test hook 2'],
      recommended_tone: 'warm and curious',
      prosodic_summary: null,
      facial_analysis: null,
      body_language: null,
      media_type: 'audio',
      video_duration_sec: null,
    })
    .select()
    .single()

  if (insertError) {
    return res.status(200).json({
      result: 'INSERT_FAILED',
      error_message: insertError.message,
      error_code: insertError.code,
      error_details: insertError.details,
      error_hint: insertError.hint,
      full_error: JSON.parse(JSON.stringify(insertError)),
      fk_checks: fkChecks,
    })
  }

  // Step 3: Clean up the test row
  if (log?.id) {
    await supabase.from('wa_perception_logs').delete().eq('id', log.id)
  }

  return res.status(200).json({
    result: 'INSERT_OK',
    log_id: log?.id ?? null,
    cleaned_up: true,
    fk_checks: fkChecks,
  })
}
