import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { HttpApiError } from "effect/unstable/httpapi"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(
  self: Effect.Effect<A, StorageNotFoundError, R>,
): Effect.Effect<A, ApiError.ApiNotFoundError, R>
export function mapStorageNotFound<A, R>(
  self: Effect.Effect<A, StorageNotFoundError | SessionAdmission.ControlInProgressError, R>,
): Effect.Effect<A, ApiError.ApiNotFoundError | HttpApiError.BadRequest, R>
export function mapStorageNotFound<A, R>(
  self: Effect.Effect<A, StorageNotFoundError | SessionAdmission.ControlInProgressError, R>,
) {
  return self.pipe(
    Effect.mapError((error) =>
      error instanceof SessionAdmission.ControlInProgressError
        ? new HttpApiError.BadRequest({})
        : ApiError.notFound(error.message),
    ),
  )
}

export function mapBusy<A, R>(
  self: Effect.Effect<A, Session.BusyError, R>,
): Effect.Effect<A, ApiError.SessionBusyError, R>
export function mapBusy<A, R>(
  self: Effect.Effect<A, Session.BusyError | SessionAdmission.ControlInProgressError, R>,
): Effect.Effect<A, ApiError.SessionBusyError | HttpApiError.BadRequest, R>
export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError | SessionAdmission.ControlInProgressError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
    Effect.catchTag("SessionAdmission.ControlInProgressError", () => new HttpApiError.BadRequest({})),
  )
}
