import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Context, Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

/** Keeps an optional caller-selected location distinct from the compatibility fallback used for request routing. */
export type RequestLocationInfo = {
  readonly explicit?: Location.Ref
  readonly resolved: Location.Ref
}

/** Exposes the current request's explicit and fallback location references without loading location services. */
export class RequestLocation extends Context.Service<RequestLocation, RequestLocationInfo>()(
  "@opencode/HttpApiRequestLocation",
) {}

/** Supplies request location references to endpoints that must validate them before runtime initialization. */
export class RequestLocationMiddleware extends HttpApiMiddleware.Service<
  RequestLocationMiddleware,
  { provides: RequestLocation }
>()("@opencode/HttpApiRequestLocationMiddleware") {}

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@opencode/HttpApiLocation",
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

function refs(request: HttpServerRequest.HttpServerRequest): RequestLocationInfo {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-opencode-workspace"]
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : undefined)
  const explicit = directory || workspaceID
    ? Location.Ref.make({
        directory: AbsolutePath.make(directory ?? process.cwd()),
        workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
      })
    : undefined
  return {
    explicit,
    resolved: explicit ??
      Location.Ref.make({
        directory: AbsolutePath.make(process.cwd()),
      }),
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
        const location = refs(request)
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
      return yield* effect.pipe(Effect.provideService(RequestLocation, RequestLocation.of(refs(request))))
    }),
  ),
)
