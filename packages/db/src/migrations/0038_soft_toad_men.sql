CREATE TABLE "drive_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text DEFAULT 'google_drive' NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"root_folder_id" text,
	"user_email" text,
	"last_sync_token" text,
	"last_synced_at" timestamp with time zone,
	"connected_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"drive_file_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"parent_drive_file_id" text,
	"web_view_link" text,
	"icon_link" text,
	"size" integer,
	"is_folder" boolean DEFAULT false NOT NULL,
	"modified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_connections" ADD CONSTRAINT "drive_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_connections_company_uq" ON "drive_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "drive_connections_provider_idx" ON "drive_connections" USING btree ("company_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_company_drive_file_uq" ON "drive_files" USING btree ("company_id","drive_file_id");--> statement-breakpoint
CREATE INDEX "drive_files_company_parent_idx" ON "drive_files" USING btree ("company_id","parent_drive_file_id");--> statement-breakpoint
CREATE INDEX "drive_files_company_name_idx" ON "drive_files" USING btree ("company_id","name");