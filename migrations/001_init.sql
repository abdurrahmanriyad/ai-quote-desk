CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quote_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'needs_review', 'failed')),
  -- Same bytes, same case: a forwarded email delivered twice must not create two quotes.
  content_sha256 text NOT NULL,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, content_sha256),
  -- Lets child tables prove a row belongs to the same tenant as its case.
  UNIQUE (id, tenant_id)
);

CREATE INDEX quote_cases_recovery ON quote_cases (status, updated_at);

CREATE TABLE case_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, tenant_id) REFERENCES quote_cases (id, tenant_id)
);

-- Append-only audit trail: every decision about a case is recorded here.
CREATE TABLE case_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, tenant_id) REFERENCES quote_cases (id, tenant_id)
);

CREATE INDEX case_events_by_case ON case_events (case_id, id);

CREATE FUNCTION reject_event_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'case_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER case_events_append_only
  BEFORE UPDATE OR DELETE ON case_events
  FOR EACH ROW EXECUTE FUNCTION reject_event_change();
