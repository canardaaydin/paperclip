import { pgTable, uuid, text, integer, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const driveFiles = pgTable(
  "drive_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    driveFileId: text("drive_file_id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    parentDriveFileId: text("parent_drive_file_id"),
    webViewLink: text("web_view_link"),
    iconLink: text("icon_link"),
    size: integer("size"),
    isFolder: boolean("is_folder").notNull().default(false),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDriveFileUq: uniqueIndex("drive_files_company_drive_file_uq").on(
      table.companyId,
      table.driveFileId,
    ),
    companyParentIdx: index("drive_files_company_parent_idx").on(
      table.companyId,
      table.parentDriveFileId,
    ),
    companyNameIdx: index("drive_files_company_name_idx").on(table.companyId, table.name),
  }),
);
