import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const skillRevisions = pgTable(
  "skill_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillName: text("skill_name").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    body: text("body").notNull(),
    changeSummary: text("change_summary"),
    editedBy: text("edited_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    skillRevisionUq: uniqueIndex("skill_revisions_skill_revision_uq").on(
      table.skillName,
      table.revisionNumber,
    ),
    skillCreatedIdx: index("skill_revisions_skill_created_idx").on(
      table.skillName,
      table.createdAt,
    ),
  }),
);
