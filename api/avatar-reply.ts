// Step: testing web-push import in isolation
// chat imports verified OK in previous step
import webpush from 'web-push'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  return res.status(200).json({
    ok: true,
    step: 'web-push-import',
    webpushLoaded: typeof webpush.sendNotification === 'function',
  })
}
