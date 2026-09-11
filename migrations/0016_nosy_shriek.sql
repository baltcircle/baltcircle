CREATE TABLE "support_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_feedback" ADD CONSTRAINT "support_feedback_conversation_id_support_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."support_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_feedback" ADD CONSTRAINT "support_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_support_feedback_conv" ON "support_feedback" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_support_feedback_created" ON "support_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_support_feedback_user" ON "support_feedback" USING btree ("user_id");