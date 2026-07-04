ALTER TABLE agent_runs DROP COLUMN IF EXISTS prompt_template_version;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS model;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS provider;
