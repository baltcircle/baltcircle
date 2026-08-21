ALTER TABLE "bikes" ADD COLUMN "external_qr_code" text;--> statement-breakpoint
ALTER TABLE "bikes" ADD COLUMN "is_test_bike" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;