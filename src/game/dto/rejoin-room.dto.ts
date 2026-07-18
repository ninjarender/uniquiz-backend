import { IsNotEmpty, IsString } from 'class-validator';

/** Payload of the rejoin_room event (asyncapi RejoinRoomPayload). */
export class RejoinRoomDto {
  @IsString()
  @IsNotEmpty()
  roomId!: string;

  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @IsString()
  @IsNotEmpty()
  resumeToken!: string;
}
