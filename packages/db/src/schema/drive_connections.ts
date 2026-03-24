import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const driveConnections = pgTable(
  "drive_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("google_drive"),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    rootFolderId: text("root_folder_id"),
    userEmail: text("user_email"),
    lastSyncToken: text("last_sync_token"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    connectedByUserId: text("connected_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("drive_connections_company_uq").on(table.companyId),
    providerIdx: index("drive_connections_provider_idx").on(table.companyId, table.provider),
  }),
);
