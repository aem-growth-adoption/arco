-- Per-step LLM timing columns for call-1 (template routing) and call-2 (content fill).
-- routing_* captures the template-select step; llm_duration_ms / llm_ttft_ms capture
-- the LLM-only portion of call-2 (separate from total pipeline duration_ms).

ALTER TABLE generated_pages ADD COLUMN routing_provider TEXT;
ALTER TABLE generated_pages ADD COLUMN routing_model TEXT;
ALTER TABLE generated_pages ADD COLUMN routing_duration_ms INTEGER;
ALTER TABLE generated_pages ADD COLUMN llm_duration_ms INTEGER;
ALTER TABLE generated_pages ADD COLUMN llm_ttft_ms INTEGER;
