import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { DirectoryGrant } from "@opencode-ai/schema/directory-grant"

export const DirectoryGrantTable = sqliteTable(
  "directory_grant",
  {
    id: text().primaryKey(),
    scope: text().$type<DirectoryGrant.Scope>().notNull(),
    owner: text().notNull(),
    pattern: text().notNull(),
  },
  (table) => [uniqueIndex("directory_grant_scope_owner_pattern_idx").on(table.scope, table.owner, table.pattern)],
)
