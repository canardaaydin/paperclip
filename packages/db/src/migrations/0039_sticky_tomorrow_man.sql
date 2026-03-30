CREATE TABLE "skill_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_name" text NOT NULL,
	"revision_number" integer NOT NULL,
	"body" text NOT NULL,
	"change_summary" text,
	"edited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_revisions_skill_revision_uq" ON "skill_revisions" USING btree ("skill_name","revision_number");--> statement-breakpoint
CREATE INDEX "skill_revisions_skill_created_idx" ON "skill_revisions" USING btree ("skill_name","created_at");