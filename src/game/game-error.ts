/** Codes of the asyncapi ErrorPayload enum used by the gateway. */
export type GameErrorCode =
  | 'room_not_found'
  | 'room_not_waiting'
  | 'nickname_taken'
  | 'not_a_member'
  | 'not_host'
  | 'start_conditions_not_met'
  | 'invalid_payload'
  | 'question_finished'
  | 'invalid_resume_token';

/** Domain error the gateway turns into an `error` event (ErrorPayload). */
export class GameError extends Error {
  constructor(
    readonly code: GameErrorCode,
    message: string,
  ) {
    super(message);
  }
}
