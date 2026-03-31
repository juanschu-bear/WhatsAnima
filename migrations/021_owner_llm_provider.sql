ALTER TABLE wa_owners
  ADD COLUMN IF NOT EXISTS llm_provider text DEFAULT 'anthropic';

COMMENT ON COLUMN wa_owners.llm_provider IS 'LLM provider for chat responses: anthropic (default) or mimo';
