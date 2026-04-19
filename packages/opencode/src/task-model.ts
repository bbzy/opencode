import type { ConfigTaskModel } from "@/config/task-model"

export function selectModel(config: ConfigTaskModel.Config, level: number): string | undefined {
  if (level === 0) return undefined
  const candidates = Object.entries(config).filter(([, entry]) => entry.level === level)
  if (candidates.length === 0) return undefined
  const [key] = candidates[Math.floor(Math.random() * candidates.length)]
  return key
}

export function describeCatalog(config: ConfigTaskModel.Config): string {
  const lines = Object.entries(config)
    .filter(([, entry]) => entry.level !== 0)
    .map(([key, entry]) => `- ${key}: ${entry.name} (level: ${entry.level})`)
  return ["Available task models:", ...lines].join("\n")
}

export * as TaskModel from "./task-model"
