import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
);

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, history, conversationId, systemPrompt } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('[chat] ANTHROPIC_API_KEY not set');
      return res.status(500).json({ error: 'LLM API key not configured' });
    }

    // Build system prompt
    let finalSystemPrompt = systemPrompt || '';
    if (!finalSystemPrompt && conversationId) {
      // Try to fetch from wa_owners
      try {
        const { data: convData } = await supabase
          .from('wa_conversations')
          .select('owner_id')
          .eq('id', conversationId)
          .single();
        if (convData?.owner_id) {
          const { data: ownerData } = await supabase
            .from('wa_owners')
            .select('system_prompt')
            .eq('id', convData.owner_id)
            .single();
          if (ownerData?.system_prompt) {
            finalSystemPrompt = ownerData.system_prompt;
          }
        }
      } catch (e) {
        console.warn('[chat] Could not fetch system prompt:', e);
      }
    }

    // Append language instruction
    finalSystemPrompt += '\n\nCRITICAL: Always respond in the same language the user\'s last message is written in. If they write Spanish, respond in Spanish. If German, German. If English, English. Never mix languages unless the user does. Never use em-dashes.';

    // Build messages array
    const messages: Array<{role: string, content: string}> = [];
    if (history && Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        messages.push({
          role: h.role === 'user' || h.sender === 'contact' ? 'user' : 'assistant',
          content: h.content || ''
        });
      }
    }
    messages.push({ role: 'user', content: message });

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 300,
      system: finalSystemPrompt,
      messages: messages as any
    });

    const content = response.content[0]?.type === 'text' ? response.content[0].text : '';
    return res.status(200).json({ content });

  } catch (error: any) {
    console.error('[chat] Error:', error.message || error);
    return res.status(500).json({ error: error.message || 'Chat request failed' });
  }
}
