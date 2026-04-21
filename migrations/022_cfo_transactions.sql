-- Migration 022: cfo_transactions
--
-- Storage for receipt images forwarded to the Jordan Cash avatar.
-- Populated by api/chat.ts after running GPT-4 Vision extraction on the
-- uploaded receipt image. One row per successfully processed receipt.
--
-- Category values are constrained by the closed list maintained in
-- api/_lib/cfoCategories.ts. We intentionally do NOT enforce the list
-- as a DB CHECK / ENUM — the taxonomy will evolve and schema migrations
-- for every edit would be painful. Application layer owns validation.

CREATE TABLE cfo_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             uuid NOT NULL REFERENCES wa_owners(id),
  contact_id           uuid NOT NULL REFERENCES wa_contacts(id),
  conversation_id      uuid,
  message_id           uuid,
  image_url            text NOT NULL,
  merchant             text,
  transaction_date     date,
  total_amount         numeric(10, 2),
  currency             text DEFAULT 'EUR',
  vat_amount           numeric(10, 2),
  category             text,
  category_confidence  numeric(3, 2),
  free_tags            text[] DEFAULT '{}',
  line_items           jsonb DEFAULT '[]'::jsonb,
  is_business_expense  boolean DEFAULT false,
  tax_relevant         boolean DEFAULT false,
  payment_method       text,
  notes                text,
  raw_vision_response  jsonb,
  extraction_status    text DEFAULT 'pending',  -- pending | ok | failed
  extraction_error     text,
  created_at           timestamptz DEFAULT now()
);

CREATE INDEX idx_cfo_trans_contact_date
  ON cfo_transactions (contact_id, transaction_date DESC);

CREATE INDEX idx_cfo_trans_owner
  ON cfo_transactions (owner_id);

CREATE INDEX idx_cfo_trans_category
  ON cfo_transactions (category, transaction_date DESC);
