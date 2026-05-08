-- PDF document sharing + retrieval context

CREATE TABLE IF NOT EXISTS public.wa_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.wa_conversations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  uploaded_by_message_id uuid REFERENCES public.wa_messages(id) ON DELETE SET NULL,
  uploader_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  file_url text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/pdf',
  byte_size bigint NOT NULL DEFAULT 0,
  page_count integer,
  extracted_text text,
  extraction_status text NOT NULL DEFAULT 'ready' CHECK (extraction_status IN ('pending', 'ready', 'failed')),
  extraction_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wa_document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.wa_documents(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.wa_conversations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

ALTER TABLE public.wa_messages
  ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES public.wa_documents(id) ON DELETE SET NULL;

ALTER TABLE public.wa_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_document_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "documents_owner_select" ON public.wa_documents;
CREATE POLICY "documents_owner_select" ON public.wa_documents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.wa_owners owners
      WHERE owners.id = wa_documents.owner_id
        AND owners.user_id = auth.uid()
        AND owners.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "document_chunks_owner_select" ON public.wa_document_chunks;
CREATE POLICY "document_chunks_owner_select" ON public.wa_document_chunks
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.wa_owners owners
      WHERE owners.id = wa_document_chunks.owner_id
        AND owners.user_id = auth.uid()
        AND owners.deleted_at IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_wa_documents_conversation_created
  ON public.wa_documents (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_documents_owner_created
  ON public.wa_documents (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_document_chunks_document_chunk
  ON public.wa_document_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_wa_document_chunks_conversation
  ON public.wa_document_chunks (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_document_id
  ON public.wa_messages (document_id);
