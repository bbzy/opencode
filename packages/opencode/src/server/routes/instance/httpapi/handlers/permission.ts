import { DirectoryGrant } from "@opencode-ai/core/permission/directory"
import { InstanceState } from "@/effect/instance-state"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PermissionNotFoundError } from "../errors"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const grants = yield* DirectoryGrant.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          reply: ctx.payload.reply,
          message: ctx.payload.message,
          scope: ctx.payload.scope,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("reply", reply)
      .handle(
        "directories",
        Effect.fn(function* (ctx) {
          const instance = yield* InstanceState.context
          return yield* grants.list({ sessionID: ctx.query.sessionID, projectID: instance.project.id })
        }),
      )
      .handle(
        "revokeDirectory",
        Effect.fn(function* (ctx) {
          const instance = yield* InstanceState.context
          yield* grants.remove({ sessionID: ctx.query.sessionID, projectID: instance.project.id }, ctx.params.id)
          return true
        }),
      )
  }),
)
