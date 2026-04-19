import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { ConfigTaskModel } from "@/config/task-model"
import { TaskModel } from "@/task-model"
import { tmpdir } from "./fixture/fixture"

describe("task-model.selectModel", () => {
  const config: ConfigTaskModel.Config = {
    "provider/never": { name: "Never", level: 0 },
    "provider/cheap": { name: "Cheap", level: 1 },
    "provider/mid": { name: "Mid", level: 2 },
    "provider/best": { name: "Best", level: 3 },
    "provider/alt-best": { name: "Alt Best", level: 3 },
  }

  it("returns undefined when level is 0", () => {
    const selected = TaskModel.selectModel(config, 0)
    expect(selected).toBeUndefined()
  })

  it("returns undefined when no models match the requested level", () => {
    const selected = TaskModel.selectModel(config, 4)
    expect(selected).toBeUndefined()
  })

  it("selects a model from the requested level", () => {
    const selected = TaskModel.selectModel(config, 1)
    expect(selected).toBe("provider/cheap")
  })

  it("selects a model from level 3 candidates", () => {
    const selected = TaskModel.selectModel(config, 3)
    expect(selected).toBeDefined()
    expect(["provider/best", "provider/alt-best"]).toContain(selected!)
  })

  it("selects from level 2 models when level 2 is requested", () => {
    const selected = TaskModel.selectModel(config, 2)
    expect(selected).toBe("provider/mid")
  })
})

describe("task-model.describeCatalog", () => {
  it("formats the catalog for LLM consumption", () => {
    const config: ConfigTaskModel.Config = {
      "provider/cheap": { name: "Cheap", level: 1 },
      "provider/best": { name: "Best", level: 3 },
    }
    const description = TaskModel.describeCatalog(config)
    expect(description).toContain("provider/cheap: Cheap (level: 1)")
    expect(description).toContain("provider/best: Best (level: 3)")
    expect(description).toContain("Available task models:")
  })

  it("excludes level 0 models from the catalog", () => {
    const config: ConfigTaskModel.Config = {
      "provider/never": { name: "Never", level: 0 },
      "provider/cheap": { name: "Cheap", level: 1 },
    }
    const description = TaskModel.describeCatalog(config)
    expect(description).not.toContain("provider/never")
    expect(description).toContain("provider/cheap")
  })
})

describe("ConfigTaskModel.loadFromDir", () => {
  it("loads a valid task_model.json", async () => {
    await using tmp = await tmpdir({
      init: async (dir: string) => {
        await fs.writeFile(
          path.join(dir, "task_model.json"),
          JSON.stringify({
            "provider/model-a": { name: "Model A", level: 2 },
          }),
        )
        return dir
      },
    })

    const config = await Effect.runPromise(ConfigTaskModel.loadFromDir(tmp.path))
    expect(config).toBeDefined()
    expect(config?.["provider/model-a"]).toEqual({ name: "Model A", level: 2 })
  })

  it("returns undefined when task_model.json does not exist", async () => {
    await using tmp = await tmpdir()
    const config = await Effect.runPromise(ConfigTaskModel.loadFromDir(tmp.path))
    expect(config).toBeUndefined()
  })

  it("throws JsonError for invalid JSON", async () => {
    await using tmp = await tmpdir({
      init: async (dir: string) => {
        await fs.writeFile(path.join(dir, "task_model.json"), "not valid json{{{")
        return dir
      },
    })
    expect(Effect.runPromise(ConfigTaskModel.loadFromDir(tmp.path))).rejects.toThrow("ConfigJsonError")
  })

  it("throws InvalidError for schema mismatch", async () => {
    await using tmp = await tmpdir({
      init: async (dir: string) => {
        await fs.writeFile(
          path.join(dir, "task_model.json"),
          JSON.stringify({ "bad/model": { name: "Bad", level: "not-a-number" } }),
        )
        return dir
      },
    })
    expect(Effect.runPromise(ConfigTaskModel.loadFromDir(tmp.path))).rejects.toThrow("ConfigInvalidError")
  })
})
