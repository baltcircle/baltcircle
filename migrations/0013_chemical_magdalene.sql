ALTER TABLE "rides" ADD COLUMN "expiry_notified_mask" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "expiry_notified_for" bigint;