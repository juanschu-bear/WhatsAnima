import { createClient } from '@supabase/supabase-js';

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY;
  if (!url) return { client: null, missing: 'SUPABASE_URL' };
  if (!key) return { client: null, missing: 'SUPABASE_SERVICE_KEY' };
  return { client: createClient(url, key), missing: null };
}

const OPM_URL = 'https://boardroom-api.onioko.com/api/v1/process';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { client: supabase, missing } = getSupabaseAdmin();
  if (!supabase) {
    return res.status(503).json({ error: `DB not configured – missing ${missing}` });
  }

  try {
    const { audio, conversationId, contactId, ownerId, filename, contentType } = req.body;
    if (!audio || !conversationId || !contactId) {
      return res.status(400).json({ error: 'audio, conversationId, and contactId are required' });
    }

    const buffer = Buffer.from(audio, 'base64');
    const blob = new Blob([buffer], { type: contentType || 'audio/webm' });

    const formData = new FormData();
    formData.append('file', blob, filename || 'audio.webm');
    formData.append('session_id', conversationId);
    formData.append('user_hash', contactId);

    const opmResponse = await fetch(OPM_URL, {
      method: 'POST',
      body: formData,
    });

    let opmData: any = null;
    if (opmResponse.ok) {
      opmData = await opmResponse.json().catch(() => null);
    } else {
      const errText = await opmResponse.text().catch(() => '');
      console.warn('[opm-process] OPM returned', opmResponse.status, errText);
    }

    // Store results in wa_perception_logs using service key (bypasses RLS)
    if (opmData) {
      const echo = opmData.echo_analysis?.audio_features;
      const { error } = await supabase
        .from('wa_perception_logs')
        .insert({
          conversation_id: conversationId,
          contact_id: contactId,
          owner_id: ownerId ?? null,
          transcript: echo?.transcript ?? null,
          primary_emotion: echo?.primary_emotion ?? null,
          secondary_emotion: echo?.secondary_emotion ?? null,
          fired_rules: opmData.echo_analysis?.fired_rules ?? [],
          behavioral_summary: opmData.session?.lucid_interpretation?.interpretation ?? null,
          conversation_hooks: opmData.session?.session_analysis?.session_patterns ?? [],
          recommended_tone: null,
          prosodic_summary: echo?.prosodic_summary ?? null,
          audio_duration_sec: opmData.echo_analysis?.duration_sec ?? null,
        });

      if (error) console.warn('[opm-process] perception log insert error:', error.message);
    }

    return res.status(200).json({ success: true, data: opmData });
  } catch (error: any) {
    console.error('[opm-process] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'OPM processing failed' });
  }
}
