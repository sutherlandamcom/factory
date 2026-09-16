ALTER TABLE "accepted_summary_artifacts" DROP CONSTRAINT IF EXISTS "accepted_summary_artifacts_project_version_unique";
ALTER TABLE "accepted_summary_artifacts" ADD CONSTRAINT "accepted_summary_artifacts_project_page_version_unique" UNIQUE ("project_id", "page_identity", "version");

ALTER TABLE "accepted_audio_artifacts" DROP CONSTRAINT IF EXISTS "accepted_audio_artifacts_project_version_unique";
ALTER TABLE "accepted_audio_artifacts" ADD CONSTRAINT "accepted_audio_artifacts_project_page_version_unique" UNIQUE ("project_id", "page_identity", "version");

ALTER TABLE "accepted_derivative_sets" DROP CONSTRAINT IF EXISTS "accepted_derivative_sets_project_version_unique";
