PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  current_focus_version_id TEXT REFERENCES focus_statement_versions(id),
  current_about_version_id TEXT REFERENCES about_statement_versions(id),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  budget_cap_monthly REAL DEFAULT 35,
  briefing_cron TEXT DEFAULT '0 5 * * 1-5',
  relevance_threshold REAL DEFAULT 0.4,
  near_miss_floor REAL DEFAULT 0.25,
  retention_days INTEGER DEFAULT 365,
  source_config TEXT DEFAULT '{}',
  filter_prompt TEXT,
  source_filter_overrides TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE focus_statement_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE about_statement_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE concepts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  aliases TEXT DEFAULT '[]',
  category TEXT,
  description TEXT,
  focus_version_id TEXT REFERENCES focus_statement_versions(id),
  suppressed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, canonical_name)
);

CREATE TABLE concept_depth (
  concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  depth_score REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  exposure_count INTEGER NOT NULL DEFAULT 0,
  last_exposed_at TEXT,
  last_calibrated_at TEXT,
  decay_warned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE concept_depth_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  depth_score REAL NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  change_source TEXT NOT NULL,
  change_detail TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE concept_relations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  target_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'generalizes', 'specializes', 'adjacent-to', 'prerequisite-of', 'related-to'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_concept_id, target_concept_id, relation_type)
);

CREATE TABLE concept_artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_url TEXT,
  artifact_title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(concept_id, artifact_type, artifact_id)
);

CREATE TABLE briefings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  briefing_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN (
    'generating', 'generated', 'partial', 'failed', 'read', 'archived'
  )),
  greeting TEXT,
  work_context_summary TEXT,
  work_context_sources TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  models_used TEXT DEFAULT '{}',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  focus_version_id TEXT REFERENCES focus_statement_versions(id),
  redundant_drafts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, briefing_date)
);

CREATE TABLE teaching_pieces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  piece_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_reference TEXT,
  selection_reasoning TEXT,
  concepts TEXT NOT NULL DEFAULT '[]',
  target_depth REAL,
  content TEXT NOT NULL,
  read_time_minutes INTEGER,
  feedback TEXT CHECK (feedback IN ('positive', 'negative', NULL)),
  read_at TEXT,
  model_used TEXT,
  source_context TEXT DEFAULT '[]',
  due_at TEXT,
  due_reason TEXT,
  series_id TEXT,
  part_number INTEGER,
  deep_dive_content TEXT,
  deep_dive_read_time INTEGER,
  has_deep_dive INTEGER NOT NULL DEFAULT 0,
  deep_dive_read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE piece_resources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  teaching_piece_id TEXT NOT NULL REFERENCES teaching_pieces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  is_deep_dive_only BOOLEAN DEFAULT FALSE,
  position INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE near_misses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  source_label TEXT,
  relevance_score REAL,
  exclusion_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE discovered_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  relevance_concepts TEXT DEFAULT '[]',
  relevance_score REAL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_in_briefing_id TEXT REFERENCES briefings(id),
  expires_at TEXT,
  UNIQUE(user_id, url)
);

CREATE TABLE calibration_quizzes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  teaching_piece_id TEXT REFERENCES teaching_pieces(id),
  quiz_type TEXT NOT NULL DEFAULT 'inline' CHECK (quiz_type IN (
    'inline', 'baseline'
  )),
  question TEXT NOT NULL,
  context TEXT,
  expected_depth_indicators TEXT,
  user_answer TEXT,
  assessed_depth REAL,
  assessment_reasoning TEXT,
  assessment_gaps TEXT,
  assessment_learning_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'answered', 'skipped'
  )),
  completed_at TEXT,
  model_used TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unified spend ledger.
--
-- Single table for everything Primer pays for, across modalities and
-- providers:
--   - LLM calls   (modality='text', input_tokens / output_tokens / reasoning / cache_*)
--   - TTS calls   (modality='tts',  audio_chars / voice)
--
-- Every row carries the provider explicitly so analytics can break
-- down spend by provider AND modality without substring sniffing the
-- model id. Adding new providers (OpenAI LLM, Gemini, ElevenLabs TTS)
-- is purely additive — no further schema work.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Service-layer operation tag: 'teaching_generation', 'concept_extraction',
  -- 'chat', 'audio_teaching_piece', etc.
  operation TEXT NOT NULL,
  -- 'text' for LLM completions, 'tts' for synthesized audio. Future
  -- modalities (image gen, embeddings, ASR) extend this enum without
  -- a schema change.
  modality TEXT NOT NULL CHECK (modality IN ('text', 'tts')),
  -- Provider id matching the catalog (anthropic | openai | google |
  -- workers-ai | openrouter | elevenlabs | cloudflare).
  provider TEXT NOT NULL,
  -- Catalog id or provider-native model id. Catalog ids preferred so
  -- the per-piece "Generated with X" footer survives provider model
  -- renames.
  model TEXT NOT NULL,

  -- Text usage (zero for tts rows).
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Reasoning tokens billed alongside output (OpenAI o-series, Anthropic
  -- extended thinking, Gemini thoughts). Tracked separately so analytics
  -- can show how much reasoning the user is paying for.
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  -- Prompt-cache traffic (Anthropic + OpenAI cached input). Read at ~10%
  -- of input rate; write at ~125% of input rate (Anthropic).
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,

  -- Audio usage (zero for text rows).
  audio_chars INTEGER NOT NULL DEFAULT 0,
  -- TTS voice id (Aura speaker, OpenAI voice, ElevenLabs voice). NULL
  -- for text rows.
  voice TEXT,

  -- Pre-computed cost in USD. Catalog-driven; see
  -- `src/worker/config/pricing.ts`.
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE briefing_timings (
  id TEXT PRIMARY KEY,
  briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  items_processed INTEGER,
  model_used TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  piece_id TEXT NOT NULL REFERENCES teaching_pieces(id) ON DELETE CASCADE,
  bookmark_type TEXT NOT NULL DEFAULT 'reading'
    CHECK (bookmark_type IN ('reading', 'saved')),
  scroll_position REAL DEFAULT 0,
  audio_position REAL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, piece_id)
);

CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  summary TEXT,
  compacted_at TEXT,
  page_context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  context_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'ready', 'failed', 'dismissed')),
  title TEXT NOT NULL,
  body TEXT,
  action_url TEXT,
  progress INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE source_instances (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, url)
);

CREATE INDEX idx_concepts_user ON concepts(user_id);
CREATE INDEX idx_concepts_suppressed ON concepts(user_id, suppressed_at);
CREATE INDEX idx_concept_depth_user ON concept_depth(user_id);
CREATE INDEX idx_concept_depth_history_user ON concept_depth_history(user_id, concept_id, recorded_at DESC);
CREATE INDEX idx_concepts_focus_version ON concepts(focus_version_id);
CREATE INDEX idx_concept_artifacts_type ON concept_artifacts(artifact_type, artifact_id);
CREATE INDEX idx_concept_artifacts_user ON concept_artifacts(user_id);
CREATE INDEX idx_briefings_user ON briefings(user_id);
CREATE INDEX idx_briefings_date ON briefings(briefing_date);
CREATE INDEX idx_briefings_cancel_requested ON briefings(cancel_requested) WHERE cancel_requested = 1;
CREATE INDEX idx_briefings_focus_version ON briefings(focus_version_id);
CREATE INDEX idx_teaching_pieces_briefing ON teaching_pieces(briefing_id);
CREATE INDEX idx_teaching_pieces_user ON teaching_pieces(user_id);
CREATE INDEX idx_teaching_pieces_due_at ON teaching_pieces(user_id, due_at);
CREATE INDEX idx_teaching_pieces_series ON teaching_pieces(series_id, part_number);
CREATE INDEX idx_teaching_pieces_deep_dive ON teaching_pieces(user_id, has_deep_dive);
CREATE INDEX idx_piece_resources_piece ON piece_resources(teaching_piece_id);
CREATE INDEX idx_near_misses_briefing ON near_misses(briefing_id);
CREATE INDEX idx_near_misses_user ON near_misses(user_id);
CREATE INDEX idx_discovered_items_relevance ON discovered_items(relevance_score DESC);
CREATE INDEX idx_discovered_items_user ON discovered_items(user_id);
CREATE INDEX idx_calibration_quizzes_status ON calibration_quizzes(status);
CREATE INDEX idx_calibration_quizzes_user ON calibration_quizzes(user_id);
CREATE INDEX idx_usage_events_user_created ON usage_events(user_id, created_at);
CREATE INDEX idx_usage_events_provider_created ON usage_events(provider, created_at);
CREATE INDEX idx_usage_events_modality_created ON usage_events(modality, created_at);
CREATE INDEX idx_focus_versions_user_recent ON focus_statement_versions(user_id, created_at DESC);
CREATE INDEX idx_about_versions_user_recent ON about_statement_versions(user_id, created_at DESC);
CREATE INDEX idx_briefing_timings_user_step ON briefing_timings(user_id, step_key, created_at DESC);
CREATE INDEX idx_briefing_timings_briefing ON briefing_timings(briefing_id);
CREATE INDEX idx_briefing_timings_user_created ON briefing_timings(user_id, created_at DESC);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id, updated_at DESC);
CREATE INDEX idx_bookmarks_piece ON bookmarks(piece_id);
CREATE INDEX idx_chat_threads_user ON chat_threads(user_id, updated_at DESC);
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, created_at);
CREATE INDEX idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX idx_notifications_user_active ON notifications(user_id, status, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, acknowledged_at);
CREATE INDEX idx_source_instances_enabled ON source_instances(enabled);
