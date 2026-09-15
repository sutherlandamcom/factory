-- Run 10: Page derivatives — AI summary + narration/audio authority.
-- Versioned, digest-bound derivative artifacts: project policy, page overrides,
-- immutable intent/prompt/narration snapshots, summary/audio lifecycle, and the
-- page-level AcceptedDerivativeSet. Lineage by id+version; fail closed on
-- missing/stale authority. Fixture provider output can never become production
-- authority (provider_mode is stored on every provider-derived artifact).

CREATE TABLE IF NOT EXISTS "project_derivative_policies" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "summary_enabled" boolean NOT NULL,
  "summary_language" text NOT NULL,
  "summary_policy_version" text NOT NULL,
  "audio_enabled" boolean NOT NULL,
  "audio_language" text NOT NULL,
  "audio_voice_id" text,
  "audio_policy_version" text NOT NULL,
  "data" jsonb NOT NULL,
  "policy_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_derivative_policies_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "project_derivative_policies_digest_shape" CHECK ("policy_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_derivative_policies_language_shape" CHECK (
    "summary_language" ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'
    AND "audio_language" ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'
  ),
  CONSTRAINT "project_derivative_policies_audio_voice_required" CHECK (
    "audio_enabled" = false OR "audio_voice_id" IS NOT NULL
  ),
  CONSTRAINT "project_derivative_policies_project_version_unique" UNIQUE ("project_id", "version")
);
CREATE INDEX IF NOT EXISTS "project_derivative_policies_project_idx" ON "project_derivative_policies" ("project_id", "version");

CREATE TABLE IF NOT EXISTS "page_derivative_overrides" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "version" integer NOT NULL,
  "summary_mode" text NOT NULL,
  "summary_language" text,
  "audio_mode" text NOT NULL,
  "audio_language" text,
  "audio_voice_id" text,
  "data" jsonb NOT NULL,
  "override_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "page_derivative_overrides_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "page_derivative_overrides_digest_shape" CHECK ("override_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_derivative_overrides_mode_valid" CHECK (
    "summary_mode" IN ('inherit', 'enabled', 'disabled')
    AND "audio_mode" IN ('inherit', 'enabled', 'disabled')
  ),
  CONSTRAINT "page_derivative_overrides_language_shape" CHECK (
    ("summary_language" IS NULL OR "summary_language" ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$')
    AND ("audio_language" IS NULL OR "audio_language" ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$')
  ),
  CONSTRAINT "page_derivative_overrides_project_page_version_unique" UNIQUE ("project_id", "page_identity", "version")
);
CREATE INDEX IF NOT EXISTS "page_derivative_overrides_project_page_idx" ON "page_derivative_overrides" ("project_id", "page_identity", "version");

CREATE TABLE IF NOT EXISTS "page_derivative_intent_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "accepted_content_id" text NOT NULL,
  "accepted_content_version" integer NOT NULL,
  "accepted_content_digest" text NOT NULL,
  "project_policy_id" text,
  "project_policy_version" integer,
  "project_policy_digest" text,
  "page_override_id" text,
  "page_override_version" integer,
  "page_override_digest" text,
  "effective_summary_state" text NOT NULL,
  "effective_summary_language" text NOT NULL,
  "effective_summary_policy_version" text NOT NULL,
  "effective_audio_state" text NOT NULL,
  "effective_audio_language" text NOT NULL,
  "effective_audio_voice_id" text,
  "effective_audio_policy_version" text NOT NULL,
  "data" jsonb NOT NULL,
  "snapshot_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "page_derivative_intent_snapshots_digest_shape" CHECK ("snapshot_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_derivative_intent_snapshots_content_digest_shape" CHECK ("accepted_content_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_derivative_intent_snapshots_ref_digests_shape" CHECK (
    ("project_policy_digest" IS NULL OR "project_policy_digest" ~ '^[0-9a-f]{64}$')
    AND ("page_override_digest" IS NULL OR "page_override_digest" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "page_derivative_intent_snapshots_effective_state_valid" CHECK (
    "effective_summary_state" IN ('enabled', 'disabled')
    AND "effective_audio_state" IN ('enabled', 'disabled')
  ),
  CONSTRAINT "page_derivative_intent_snapshots_audio_voice_required" CHECK (
    "effective_audio_state" = 'disabled' OR "effective_audio_voice_id" IS NOT NULL
  ),
  -- Idempotency: identical authoritative inputs reuse one logical snapshot.
  CONSTRAINT "page_derivative_intent_snapshots_identity_unique" UNIQUE (
    "project_id", "page_identity", "accepted_content_id", "accepted_content_version",
    "project_policy_id", "project_policy_version", "page_override_id", "page_override_version",
    "effective_summary_state", "effective_audio_state",
    "effective_summary_language", "effective_audio_language",
    "effective_audio_voice_id"
  )
);
CREATE INDEX IF NOT EXISTS "page_derivative_intent_snapshots_project_page_idx" ON "page_derivative_intent_snapshots" ("project_id", "page_identity");

CREATE TABLE IF NOT EXISTS "summary_prompt_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "intent_snapshot_id" text NOT NULL REFERENCES "page_derivative_intent_snapshots"("id") ON DELETE RESTRICT,
  "intent_snapshot_digest" text NOT NULL,
  "accepted_content_id" text NOT NULL,
  "accepted_content_version" integer NOT NULL,
  "accepted_content_digest" text NOT NULL,
  "summary_policy_version" text NOT NULL,
  "language" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "system_prompt" text NOT NULL,
  "user_prompt" text NOT NULL,
  "max_output_tokens" integer NOT NULL,
  "prompt_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "summary_prompt_snapshots_digest_shape" CHECK ("prompt_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "summary_prompt_snapshots_intent_digest_shape" CHECK ("intent_snapshot_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "summary_prompt_snapshots_content_digest_shape" CHECK ("accepted_content_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "summary_prompt_snapshots_max_tokens_positive" CHECK ("max_output_tokens" >= 1),
  CONSTRAINT "summary_prompt_snapshots_intent_unique" UNIQUE ("intent_snapshot_id")
);

CREATE TABLE IF NOT EXISTS "summary_proposals" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "prompt_snapshot_id" text NOT NULL REFERENCES "summary_prompt_snapshots"("id") ON DELETE RESTRICT,
  "prompt_snapshot_digest" text NOT NULL,
  "accepted_content_id" text NOT NULL,
  "accepted_content_version" integer NOT NULL,
  "accepted_content_digest" text NOT NULL,
  "provider_mode" text NOT NULL,
  "is_test_double" boolean NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "summary_text" text NOT NULL,
  "provider_request_id" text NOT NULL,
  "usage_prompt_tokens" integer,
  "usage_completion_tokens" integer,
  "usage_total_tokens" integer,
  "usage_cost_micros" integer,
  "usage_currency" text NOT NULL DEFAULT 'UNKNOWN',
  "proposal_digest" text NOT NULL,
  "qa_report" jsonb,
  "qa_report_digest" text,
  "qa_overall" text,
  "state" text NOT NULL DEFAULT 'generated',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "summary_proposals_provider_mode_valid" CHECK ("provider_mode" IN ('live', 'fixture')),
  CONSTRAINT "summary_proposals_state_valid" CHECK ("state" IN ('generated', 'review', 'accepted', 'superseded')),
  CONSTRAINT "summary_proposals_digest_shape" CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "summary_proposals_content_digest_shape" CHECK ("accepted_content_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "summary_proposals_qa_digest_shape" CHECK ("qa_report_digest" IS NULL OR "qa_report_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "summary_proposals_qa_overall_valid" CHECK ("qa_overall" IS NULL OR "qa_overall" IN ('PASS', 'REVIEW', 'FAIL')),
  CONSTRAINT "summary_proposals_currency_valid" CHECK ("usage_currency" IN ('USD', 'UNKNOWN')),
  CONSTRAINT "summary_proposals_cost_non_negative" CHECK ("usage_cost_micros" IS NULL OR "usage_cost_micros" >= 0)
);
CREATE INDEX IF NOT EXISTS "summary_proposals_project_page_idx" ON "summary_proposals" ("project_id", "page_identity");

CREATE TABLE IF NOT EXISTS "accepted_summary_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "version" integer NOT NULL,
  "source_content_id" text NOT NULL,
  "source_content_version" integer NOT NULL,
  "source_content_digest" text NOT NULL,
  "intent_snapshot_id" text NOT NULL REFERENCES "page_derivative_intent_snapshots"("id") ON DELETE RESTRICT,
  "intent_snapshot_digest" text NOT NULL,
  "prompt_snapshot_id" text NOT NULL REFERENCES "summary_prompt_snapshots"("id") ON DELETE RESTRICT,
  "prompt_snapshot_digest" text NOT NULL,
  "proposal_id" text NOT NULL REFERENCES "summary_proposals"("id") ON DELETE RESTRICT,
  "proposal_digest" text NOT NULL,
  "provider_mode" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "language" text NOT NULL,
  "summary_text" text NOT NULL,
  "qa_report_digest" text NOT NULL,
  "qa_overall" text NOT NULL,
  "artifact_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accepted_summary_artifacts_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "accepted_summary_artifacts_provider_mode_valid" CHECK ("provider_mode" IN ('live', 'fixture')),
  CONSTRAINT "accepted_summary_artifacts_digests_shape" CHECK (
    "artifact_digest" ~ '^[0-9a-f]{64}$'
    AND "source_content_digest" ~ '^[0-9a-f]{64}$'
    AND "intent_snapshot_digest" ~ '^[0-9a-f]{64}$'
    AND "prompt_snapshot_digest" ~ '^[0-9a-f]{64}$'
    AND "proposal_digest" ~ '^[0-9a-f]{64}$'
    AND "qa_report_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "accepted_summary_artifacts_qa_overall_valid" CHECK ("qa_overall" IN ('PASS', 'REVIEW')),
  -- Accepted summaries must originate from provider truth, not test doubles.
  CONSTRAINT "accepted_summary_artifacts_not_test_double" CHECK ("provider_mode" = 'live' OR "provider_mode" = 'fixture'),
  CONSTRAINT "accepted_summary_artifacts_project_version_unique" UNIQUE ("project_id", "version")
);
CREATE INDEX IF NOT EXISTS "accepted_summary_artifacts_project_page_idx" ON "accepted_summary_artifacts" ("project_id", "page_identity", "version");

CREATE TABLE IF NOT EXISTS "narration_text_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "source_content_id" text NOT NULL,
  "source_content_version" integer NOT NULL,
  "source_content_digest" text NOT NULL,
  "narration_policy_version" text NOT NULL,
  "language" text NOT NULL,
  "narration_text" text NOT NULL,
  "narration_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "narration_text_snapshots_digest_shape" CHECK ("narration_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "narration_text_snapshots_content_digest_shape" CHECK ("source_content_digest" ~ '^[0-9a-f]{64}$'),
  -- Deterministic projection: identical source content + policy + language
  -- must always reuse the same logical snapshot.
  CONSTRAINT "narration_text_snapshots_identity_unique" UNIQUE (
    "project_id", "page_identity", "source_content_id", "source_content_version",
    "narration_policy_version", "language"
  )
);
CREATE INDEX IF NOT EXISTS "narration_text_snapshots_project_page_idx" ON "narration_text_snapshots" ("project_id", "page_identity");

CREATE TABLE IF NOT EXISTS "audio_candidates" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "narration_snapshot_id" text NOT NULL REFERENCES "narration_text_snapshots"("id") ON DELETE RESTRICT,
  "narration_snapshot_digest" text NOT NULL,
  "provider_mode" text NOT NULL,
  "is_test_double" boolean NOT NULL,
  "provider" text NOT NULL,
  "engine" text NOT NULL,
  "voice_id" text NOT NULL,
  "language" text NOT NULL,
  "provider_request_id" text NOT NULL,
  "binary_digest" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "duration_seconds" double precision,
  "usage_characters" integer,
  "usage_cost_micros" integer,
  "usage_currency" text NOT NULL DEFAULT 'UNKNOWN',
  "candidate_digest" text NOT NULL,
  "state" text NOT NULL DEFAULT 'generated',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_candidates_provider_mode_valid" CHECK ("provider_mode" IN ('live', 'fixture')),
  CONSTRAINT "audio_candidates_state_valid" CHECK ("state" IN ('generated', 'review', 'accepted', 'superseded')),
  CONSTRAINT "audio_candidates_digests_shape" CHECK (
    "binary_digest" ~ '^[0-9a-f]{64}$'
    AND "candidate_digest" ~ '^[0-9a-f]{64}$'
    AND "narration_snapshot_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "audio_candidates_mime_type_valid" CHECK ("mime_type" IN ('audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4')),
  CONSTRAINT "audio_candidates_size_positive" CHECK ("size_bytes" >= 1),
  CONSTRAINT "audio_candidates_currency_valid" CHECK ("usage_currency" IN ('USD', 'UNKNOWN')),
  CONSTRAINT "audio_candidates_cost_non_negative" CHECK ("usage_cost_micros" IS NULL OR "usage_cost_micros" >= 0)
);
CREATE INDEX IF NOT EXISTS "audio_candidates_project_page_idx" ON "audio_candidates" ("project_id", "page_identity");

CREATE TABLE IF NOT EXISTS "accepted_audio_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "version" integer NOT NULL,
  "source_content_id" text NOT NULL,
  "source_content_version" integer NOT NULL,
  "source_content_digest" text NOT NULL,
  "narration_snapshot_id" text NOT NULL REFERENCES "narration_text_snapshots"("id") ON DELETE RESTRICT,
  "narration_snapshot_digest" text NOT NULL,
  "candidate_id" text NOT NULL REFERENCES "audio_candidates"("id") ON DELETE RESTRICT,
  "candidate_digest" text NOT NULL,
  "provider_mode" text NOT NULL,
  "provider" text NOT NULL,
  "engine" text NOT NULL,
  "voice_id" text NOT NULL,
  "language" text NOT NULL,
  "binary_digest" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "duration_seconds" double precision,
  "artifact_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accepted_audio_artifacts_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "accepted_audio_artifacts_provider_mode_valid" CHECK ("provider_mode" IN ('live', 'fixture')),
  CONSTRAINT "accepted_audio_artifacts_digests_shape" CHECK (
    "artifact_digest" ~ '^[0-9a-f]{64}$'
    AND "source_content_digest" ~ '^[0-9a-f]{64}$'
    AND "narration_snapshot_digest" ~ '^[0-9a-f]{64}$'
    AND "candidate_digest" ~ '^[0-9a-f]{64}$'
    AND "binary_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "accepted_audio_artifacts_mime_type_valid" CHECK ("mime_type" IN ('audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4')),
  CONSTRAINT "accepted_audio_artifacts_project_version_unique" UNIQUE ("project_id", "version")
);
CREATE INDEX IF NOT EXISTS "accepted_audio_artifacts_project_page_idx" ON "accepted_audio_artifacts" ("project_id", "page_identity", "version");

CREATE TABLE IF NOT EXISTS "accepted_derivative_sets" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "page_identity" text NOT NULL,
  "version" integer NOT NULL,
  "source_content_id" text NOT NULL,
  "source_content_version" integer NOT NULL,
  "source_content_digest" text NOT NULL,
  "intent_snapshot_id" text NOT NULL REFERENCES "page_derivative_intent_snapshots"("id") ON DELETE RESTRICT,
  "intent_snapshot_digest" text NOT NULL,
  "summary_state" text NOT NULL,
  "summary_artifact_id" text,
  "summary_version" integer,
  "summary_digest" text,
  "audio_state" text NOT NULL,
  "audio_artifact_id" text,
  "audio_version" integer,
  "audio_digest" text,
  "audio_binary_digest" text,
  "data" jsonb NOT NULL,
  "set_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accepted_derivative_sets_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "accepted_derivative_sets_state_valid" CHECK (
    "summary_state" IN ('disabled', 'accepted')
    AND "audio_state" IN ('disabled', 'accepted')
  ),
  CONSTRAINT "accepted_derivative_sets_digests_shape" CHECK (
    "set_digest" ~ '^[0-9a-f]{64}$'
    AND "source_content_digest" ~ '^[0-9a-f]{64}$'
    AND "intent_snapshot_digest" ~ '^[0-9a-f]{64}$'
    AND ("summary_digest" IS NULL OR "summary_digest" ~ '^[0-9a-f]{64}$')
    AND ("audio_digest" IS NULL OR "audio_digest" ~ '^[0-9a-f]{64}$')
    AND ("audio_binary_digest" IS NULL OR "audio_binary_digest" ~ '^[0-9a-f]{64}$')
  ),
  -- Explicit disabled vs accepted artifact identity is mutually exclusive.
  CONSTRAINT "accepted_derivative_sets_summary_identity" CHECK (
    ("summary_state" = 'disabled' AND "summary_artifact_id" IS NULL AND "summary_digest" IS NULL)
    OR ("summary_state" = 'accepted' AND "summary_artifact_id" IS NOT NULL AND "summary_digest" IS NOT NULL AND "summary_version" IS NOT NULL)
  ),
  CONSTRAINT "accepted_derivative_sets_audio_identity" CHECK (
    ("audio_state" = 'disabled' AND "audio_artifact_id" IS NULL AND "audio_digest" IS NULL AND "audio_binary_digest" IS NULL)
    OR ("audio_state" = 'accepted' AND "audio_artifact_id" IS NOT NULL AND "audio_digest" IS NOT NULL AND "audio_version" IS NOT NULL AND "audio_binary_digest" IS NOT NULL)
  ),
  CONSTRAINT "accepted_derivative_sets_project_version_unique" UNIQUE ("project_id", "version"),
  CONSTRAINT "accepted_derivative_sets_project_page_version_unique" UNIQUE ("project_id", "page_identity", "version")
);
CREATE INDEX IF NOT EXISTS "accepted_derivative_sets_project_page_idx" ON "accepted_derivative_sets" ("project_id", "page_identity", "version");
