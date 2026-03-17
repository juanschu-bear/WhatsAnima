import {
  callAnthropic,
  loadOwnerPromptAndMemory,
  buildSystemPrompt,
  prepareMessages,
  generateImageFromPrompt,
  ChatMessage,
} from './chat.js'

export default async function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, step: 'chat-imports' })
}
