ALTER TABLE "model_invocations" ADD COLUMN "worker_tier" text;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "requested_model" text;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "escalation" boolean;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "escalation_reason" text;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD COLUMN "exit_code" integer;