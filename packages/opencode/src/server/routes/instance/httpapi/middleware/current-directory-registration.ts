import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

/** Requires an explicit request directory or resolved workspace target before loading an instance to register it. */
export class CurrentDirectoryRegistrationMiddleware extends HttpApiMiddleware.Service<
  CurrentDirectoryRegistrationMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiCurrentDirectoryRegistration", { error: HttpApiError.BadRequest }) {}

/** Provides the registration guard for the explicit current-directory operation. */
export const currentDirectoryRegistrationLayer = Layer.effect(
  CurrentDirectoryRegistrationMiddleware,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return CurrentDirectoryRegistrationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        if (route.authority === "ambient") return yield* new HttpApiError.BadRequest({})
        if (!(yield* fs.isDir(FSUtil.resolve(route.directory)))) return yield* new HttpApiError.BadRequest({})
        return yield* effect
      }),
    )
  }),
)
