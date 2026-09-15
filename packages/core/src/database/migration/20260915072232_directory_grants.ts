import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260915072232_directory_grants",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`directory_grant\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`pattern\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`directory_grant_scope_owner_pattern_idx\` ON \`directory_grant\` (\`scope\`,\`owner\`,\`pattern\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
