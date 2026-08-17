CREATE TABLE "bike_telemetry" (
	"id" serial PRIMARY KEY NOT NULL,
	"bike_id" text NOT NULL,
	"imei" text,
	"cmd" text DEFAULT 'D0' NOT NULL,
	"t" bigint NOT NULL,
	"x" double precision,
	"y" double precision,
	"lat" double precision,
	"lng" double precision,
	"satellites" integer,
	"hdop" double precision,
	"altitude_m" double precision,
	"voltage_cv" integer,
	"battery_pct" integer,
	"signal_level" integer,
	"locked" boolean,
	"alarm_code" integer
);
--> statement-breakpoint
CREATE TABLE "bikes" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"battery" integer NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"last_seen" bigint NOT NULL,
	"idle_hours" double precision NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"serial" text,
	"lock_id" text,
	"parking_id" text,
	"lock_imei" text,
	"lock_online" boolean DEFAULT false NOT NULL,
	"lock_last_seen" bigint,
	"notes" text,
	"seed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_change_requests" (
	"user_id" text PRIMARY KEY NOT NULL,
	"new_email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_sent_at" bigint NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locks" (
	"id" serial PRIMARY KEY NOT NULL,
	"imei" text NOT NULL,
	"mac_address" text,
	"bike_id" text,
	"sim_iccid" text,
	"firmware_version" text,
	"apn" text DEFAULT 'cmiot' NOT NULL,
	"status" text DEFAULT 'unregistered' NOT NULL,
	"last_seen_at" bigint,
	"last_battery_voltage" numeric,
	"last_signal_strength" integer,
	"last_lock_state" text,
	"last_latitude" numeric,
	"last_longitude" numeric,
	"last_location_at" bigint,
	"ble_key" text,
	"device_type_code" text,
	"last_alarm_type" text,
	"last_alarm_at" bigint,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_objects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"kind" text NOT NULL,
	"color" text DEFAULT '#1d6f8e' NOT NULL,
	"points" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"display_name" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_requests" (
	"phone" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_sent_at" bigint NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"provider_status" text,
	"provider_error" text,
	"provider_checked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "parkings" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"capacity" integer NOT NULL,
	"occupied" integer NOT NULL,
	"radius" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"archived_at" bigint,
	"seed" boolean DEFAULT false NOT NULL,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"brand" text,
	"status" text DEFAULT 'linked' NOT NULL,
	"provider" text,
	"customer_key" text,
	"card_id" text,
	"rebill_id" text,
	"rebill_id_hash" text,
	"request_key" text,
	"account_token" text,
	"account_token_hash" text,
	"purpose" text,
	"order_id" text,
	"payment_id" text,
	"payment_url" text,
	"amount_kopecks" integer,
	"refund_status" text,
	"refund_error" text,
	"last_error_code" text,
	"last_error_message" text,
	"last_error_details" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bike_id" text NOT NULL,
	"tariff_id" text NOT NULL,
	"amount_kopecks" integer NOT NULL,
	"payment_id" text,
	"payment_url" text,
	"source" text DEFAULT 'hosted' NOT NULL,
	"payment_method_id" integer,
	"rebill_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"ride_id" integer,
	"idempotency_key" text,
	"last_error_code" text,
	"last_error_message" text,
	"last_error_details" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "payment_orders_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_change_requests" (
	"user_id" text PRIMARY KEY NOT NULL,
	"new_phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_sent_at" bigint NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth_key" text NOT NULL,
	"user_agent" text,
	"created_at" bigint NOT NULL,
	"last_success_at" bigint
);
--> statement-breakpoint
CREATE TABLE "ride_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"ride_id" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"t" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rides" (
	"id" serial PRIMARY KEY NOT NULL,
	"bike_id" text NOT NULL,
	"user_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"start_lat" double precision NOT NULL,
	"start_lng" double precision NOT NULL,
	"end_lat" double precision,
	"end_lng" double precision,
	"track" text NOT NULL,
	"distance_m" double precision DEFAULT 0 NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	"tariff" text NOT NULL,
	"status" text NOT NULL,
	"physically_locked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "support_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mode" text DEFAULT 'bot' NOT NULL,
	"last_message_at" bigint,
	"user_unread_count" integer DEFAULT 0 NOT NULL,
	"operator_unread_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "support_conversations_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"sender_role" text NOT NULL,
	"sender_id" text,
	"body" text DEFAULT '' NOT NULL,
	"attachment_url" text,
	"attachment_mime" text,
	"read_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"kind" text DEFAULT 'comment' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"bike_id" text NOT NULL,
	"kind" text NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"message" text NOT NULL,
	"assignee" text,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"closed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "unassigned_locks" (
	"imei" text PRIMARY KEY NOT NULL,
	"first_seen" bigint NOT NULL,
	"last_seen" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"email_verified_at" bigint,
	"role" text DEFAULT 'rider' NOT NULL,
	"consent_accepted_at" bigint,
	"consent_version" text,
	"consent_ip" text,
	"blocked_at" bigint,
	"blocked_reason" text,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "wallet" (
	"user_id" text PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"active_tariff" text DEFAULT 'payg' NOT NULL,
	"tariff_expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "wallet_topup_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount_kopecks" integer NOT NULL,
	"payment_id" text,
	"payment_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"last_error_details" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "wallet_topup_orders_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"polygon" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locks" ADD CONSTRAINT "locks_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_conversation_id_support_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."support_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bike_telemetry_bike_t" ON "bike_telemetry" USING btree ("bike_id","t");--> statement-breakpoint
CREATE INDEX "idx_bike_telemetry_pos" ON "bike_telemetry" USING btree ("bike_id","t") WHERE "bike_telemetry"."x" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_bikes_status" ON "bikes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bikes_lock_imei" ON "bikes" USING btree ("lock_imei") WHERE "bikes"."lock_imei" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_locks_imei" ON "locks" USING btree ("imei");--> statement-breakpoint
CREATE INDEX "idx_locks_bike_id" ON "locks" USING btree ("bike_id");--> statement-breakpoint
CREATE INDEX "idx_locks_status" ON "locks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_provider_subject" ON "oauth_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "idx_oauth_user" ON "oauth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pm_user" ON "payment_methods" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pm_user_provider_status" ON "payment_methods" USING btree ("user_id","provider","status");--> statement-breakpoint
CREATE INDEX "idx_pm_order" ON "payment_methods" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_pm_request_key" ON "payment_methods" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "idx_pm_rebill_hash" ON "payment_methods" USING btree ("rebill_id_hash");--> statement-breakpoint
CREATE INDEX "idx_pm_account_hash" ON "payment_methods" USING btree ("account_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_po_user_idempotency" ON "payment_orders" USING btree ("user_id","idempotency_key") WHERE "payment_orders"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_po_order" ON "payment_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_po_user" ON "payment_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_po_payment" ON "payment_orders" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "idx_payments_user" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_push_endpoint" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "idx_push_user" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ride_points_ride" ON "ride_points" USING btree ("ride_id","id");--> statement-breakpoint
CREATE INDEX "idx_rides_user_status" ON "rides" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_rides_user" ON "rides" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_rides_bike" ON "rides" USING btree ("bike_id");--> statement-breakpoint
CREATE INDEX "idx_rides_started" ON "rides" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_support_conv_user" ON "support_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_support_conv_last" ON "support_conversations" USING btree ("last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_support_msg_conv" ON "support_messages" USING btree ("conversation_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_support_tickets_user" ON "support_tickets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_comments_ticket" ON "ticket_comments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_bike" ON "tickets" USING btree ("bike_id");--> statement-breakpoint
CREATE INDEX "idx_users_phone" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_wto_order" ON "wallet_topup_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_wto_user" ON "wallet_topup_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_wto_payment" ON "wallet_topup_orders" USING btree ("payment_id");