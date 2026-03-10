export default function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const opmUrl = process.env.OPM_API_URL || ''
  const opmPreset = process.env.OPM_PRESET || 'celebrity_ceo'

  return res.status(200).json({
    opm_api_url: opmUrl || null,
    opm_preset: opmPreset,
  })
}
