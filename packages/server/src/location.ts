import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { Context, Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

/** Keeps an optional caller-selected location distinct from the compatibility fallback used for request routing. */
export type RequestLocationInfo = {
  readonly explicit?: Location.Ref
  readonly resolved: Location.Ref
  /** A workspace without a directory cannot identify a Location. */
  readonly invalidWorkspaceOnly?: true
}

/** Exposes the current request's explicit and fallback location references without loading location services. */
export class RequestLocation extends Context.Service<RequestLocation, RequestLocationInfo>()(
  "@opencode/HttpApiRequestLocation",
) {}

/** Supplies request location references to endpoints that must validate them before runtime initialization. */
export class RequestLocationMiddleware extends HttpApiMiddleware.Service<
  RequestLocationMiddleware,
  { provides: RequestLocation }
>()("@opencode/HttpApiRequestLocationMiddleware", { error: InvalidRequestError }) {}

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@opencode/HttpApiLocation",
  { error: InvalidRequestError },
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

/** Parses location headers and query parameters without inventing a directory for workspace-only requests. */
export function requestLocationInfo(request: {
  readonly url: string
  readonly headers: Record<string, string | undefined>
}): RequestLocationInfo {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-opencode-workspace"]
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : undefined)
  const explicit = directory
    ? Location.Ref.make({
        directory: AbsolutePath.make(directory),
        workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
      })
    : undefined
  return {
    explicit,
    resolved: explicit ?? Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
    ...(workspaceID && !directory ? { invalidWorkspaceOnly: true as const } : {}),
  }
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const location = requestLocationInfo(request)
        if (location.invalidWorkspaceOnly)
          return yield* new InvalidRequestError({
            message: "A workspace location requires a directory",
            field: "location",
          })
        return yield* effect.pipe(Effect.provide(locations.get(location.resolved)))
      }),
    )
  }),
)

/** Provides the request-location middleware without resolving a `LocationServiceMap` entry. */
export const requestLocationLayer = Layer.succeed(
  RequestLocationMiddleware,
  RequestLocationMiddleware.of((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const location = requestLocationInfo(request)
      if (location.invalidWorkspaceOnly)
        return yield* new InvalidRequestError({
          message: "A workspace location requires a directory",
          field: "location",
        })
      return yield* effect.pipe(Effect.provideService(RequestLocation, RequestLocation.of(location)))
    }),
  ),
)
