const MOCK_RESPONSE = {
  echo_analysis: {
    fired_rules: [
      { name: 'conviction_alignment', confidence: 0.78, category: 'authenticity' },
      { name: 'rehearsed_delivery', confidence: 0.65, category: 'delivery' },
      { name: 'topic_specific_hesitation', confidence: 0.82, category: 'cognitive' },
    ],
    audio_features: {
      transcript: "I'm not sure this approach is going to work...",
      primary_emotion: 'frustrated',
      secondary_emotion: 'determined',
      confidence: 0.82,
      valence: -0.4,
      arousal: 0.6,
      prosodic_summary: {
        pitch_range_hz: null,
        estimated_fundamental_hz: 142.5,
        zero_crossing_rate: 0.08,
        pause_count: 3,
        speaking_rate_wps: 2.4,
        speech_ratio: 0.78,
        voice_tremor: 0.02,
        voice_stability: 0.95,
      },
    },
    duration_sec: 8.3,
    processing_ms: 2840,
    skipped_reason: null,
  },
  standard_analysis: null,
  session: {
    session_analysis: {
      session_patterns: [
        'User likely wants affirmation, not alternatives',
        'Frustration is directed at a situation, not at the conversation partner',
        'Micro-expression shift at 7.8s suggests emerging resolve',
      ],
    },
    lucid_interpretation: {
      interpretation:
        'User presents as frustrated but resolved. Initial neutral expression gave way to visible frustration, likely directed at a specific situation rather than the conversation. A notable shift toward determination emerged in the final moments, suggesting the user is looking for validation of their resolve rather than alternatives.',
    },
  },
}

export default function handler(req: any, res: any) {
  if (req.method === 'GET') {
    const { action, job_id } = req.query || {}
    if (!action || !job_id) {
      return res.status(400).json({ error: 'Missing action or job_id' })
    }

    if (action === 'status') {
      return res.status(200).json({ job_id, status: 'complete', stage: 'done', progress: 100, _mock: true })
    }

    if (action === 'results') {
      return res.status(200).json({ ...MOCK_RESPONSE, _mock: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  }

  if (req.method === 'POST') {
    const mockJobId = 'mock_job_' + Date.now()
    return res.status(200).json({ job_id: mockJobId, _mock: true })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
}
