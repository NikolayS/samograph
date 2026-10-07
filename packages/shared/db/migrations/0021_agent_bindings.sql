-- Hosted agent spike: capability metadata, durable send reservation, shared rate state.
CREATE TABLE agent_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  token_id uuid NOT NULL UNIQUE REFERENCES tokens(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('codex','claude-code','other')),
  native_session_id text NOT NULL CHECK (length(native_session_id) BETWEEN 1 AND 200),
  label text NOT NULL CHECK (length(label) <= 80),
  min_seq bigint NOT NULL CHECK (min_seq >= 0),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_request_at timestamptz,
  context_window timestamptz,
  context_count integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX agent_bindings_one_live ON agent_bindings(call_id) WHERE revoked_at IS NULL;
CREATE TABLE agent_chat_requests (
  binding_id uuid NOT NULL REFERENCES agent_bindings(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  content_sha256 text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('submitted','accepted','unknown','rejected')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(binding_id,request_id)
);
CREATE INDEX agent_chat_requests_rate ON agent_chat_requests(call_id,created_at);
ALTER TABLE agent_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_bindings_tenant ON agent_bindings FOR ALL TO samograph_app
  USING (EXISTS (SELECT 1 FROM calls c WHERE c.id = agent_bindings.call_id AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM calls c WHERE c.id = agent_bindings.call_id AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid));
ALTER TABLE agent_chat_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_chat_requests_tenant ON agent_chat_requests FOR ALL TO samograph_app
  USING (EXISTS (SELECT 1 FROM calls c WHERE c.id = agent_chat_requests.call_id AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM agent_bindings b JOIN calls c ON c.id = b.call_id WHERE b.id = agent_chat_requests.binding_id AND b.call_id = agent_chat_requests.call_id AND c.tenant_id = (SELECT current_setting('app.tenant_id'))::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_bindings, agent_chat_requests TO samograph_app;
