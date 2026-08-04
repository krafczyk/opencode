import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260804055123_permission-directory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`permission\` ADD \`directory\` text;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`permission_project_action_resource_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_directory_action_resource_idx\` ON \`permission\` (\`project_id\`,coalesce("directory", ''),\`action\`,\`resource\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
