import { makeDefaultApi } from "@opencode-ai/protocol/api"
import { LocationMiddleware, RequestLocationMiddleware } from "./location"
import { SessionLocationMiddleware } from "./middleware/session-location"

export const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  requestLocationMiddleware: RequestLocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})
