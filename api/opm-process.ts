export const config = {
  api: { bodyParser: { sizeLimit: '500mb' } },
}

const OPM_URL = 'https://boardroom-api.onioko.com/api/v1/process';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { audio, conversationId, contactId, filename, contentType } = req.body;
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

    // Return OPM data to caller — DB insert happens in create-perception-log
    return res.status(200).json({ success: true, data: opmData });
  } catch (error: any) {
    console.error('[opm-process] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'OPM processing failed' });
  }
}
