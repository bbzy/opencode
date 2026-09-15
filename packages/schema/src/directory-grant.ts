export * as DirectoryGrant from "./directory-grant"

import { Schema } from "effect"

export const Scope = Schema.Literals(["session", "project", "global"])
export type Scope = typeof Scope.Type

export const Info = Schema.Struct({
  id: Schema.String,
  scope: Scope,
  owner: Schema.String,
  pattern: Schema.String,
}).annotate({ identifier: "DirectoryGrant" })
export type Info = typeof Info.Type
