-- Add template_name column to track which page template was selected by the routing LLM.
ALTER TABLE generated_pages ADD COLUMN template_name TEXT;
