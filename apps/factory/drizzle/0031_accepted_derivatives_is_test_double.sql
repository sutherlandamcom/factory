ALTER TABLE "accepted_summary_artifacts" ADD COLUMN "is_test_double" boolean NOT NULL DEFAULT false;
ALTER TABLE "accepted_audio_artifacts" ADD COLUMN "is_test_double" boolean NOT NULL DEFAULT false;
