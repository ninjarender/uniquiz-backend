/** Payload of the host JWT (sub = user id). */
export interface JwtPayload {
  sub: string;
  email: string;
}
