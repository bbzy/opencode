export * as ConfigTaskModel from "./task-model"

import path from "path"
import { Effect, Exit, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { JsonError, InvalidError } from "@opencode-ai/core/v1/config/error"

export const Entry = Schema.Struct({
  name: Schema.String,
  level: Schema.Number,
})

export const Config = Schema.Record(Schema.String, Entry)
export type Config = Schema.Schema.Type<typeof Config>
export type EntryType = Schema.Schema.Type<typeof Entry>

const decodeExit = Schema.decodeUnknownExit(Config)

export type LoadError = InstanceType<typeof JsonError> | InstanceType<typeof InvalidError>

export function filepath(): string {
  return path.join(Global.Path.config, "task_model.json")
}

export function load(): Effect.Effect<Config | undefined, LoadError, never> {
  return loadFromDir(Global.Path.config)
}

export function loadFromDir(dir: string): Effect.Effect<Config | undefined, LoadError, never> {
  return Effect.gen(function* () {
    const fp = path.join(dir, "task_model.json")
    const file = Bun.file(fp)
    const exists = yield* Effect.promise(() => file.exists())
    if (!exists) return undefined
    const text = yield* Effect.promise(() => file.text())
    const json: unknown = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => new JsonError({ path: fp, message: "task_model.json is not valid JSON" }) as LoadError,
    })
    const exit = decodeExit(json)
    if (!Exit.isSuccess(exit)) return yield* Effect.fail(new InvalidError({ path: fp, message: "task_model.json schema validation failed" }) as LoadError)
    return exit.value
  })
}
