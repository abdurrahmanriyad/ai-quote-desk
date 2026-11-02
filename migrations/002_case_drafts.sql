-- The latest draft for a case. A retried job replaces it rather than adding a second one.
CREATE TABLE case_drafts (
  case_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  model text NOT NULL,
  extraction jsonb NOT NULL,
  lines jsonb NOT NULL,
  price jsonb NOT NULL,
  review_issues jsonb NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, tenant_id) REFERENCES quote_cases (id, tenant_id)
);
