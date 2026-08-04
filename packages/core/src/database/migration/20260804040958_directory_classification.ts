import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260804040958_directory_classification",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project_directory\` ADD \`kind\` text DEFAULT 'user' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`project_directory\` ADD \`source_directory\` text;`)
      yield* tx.run(`UPDATE \`project_directory\` SET \`kind\` = 'managed' WHERE \`strategy\` IS NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
