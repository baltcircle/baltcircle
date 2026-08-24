CREATE TABLE "ride_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"ride_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"comment" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ride_feedback" ADD CONSTRAINT "ride_feedback_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_feedback" ADD CONSTRAINT "ride_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_ride_feedback_ride" ON "ride_feedback" USING btree ("ride_id");--> statement-breakpoint
CREATE INDEX "idx_ride_feedback_rating" ON "ride_feedback" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "idx_ride_feedback_created" ON "ride_feedback" USING btree ("created_at");