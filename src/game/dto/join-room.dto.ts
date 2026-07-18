import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Payload of the join_room event (asyncapi JoinRoomPayload). */
export class JoinRoomDto {
  @IsString()
  @IsNotEmpty()
  roomId!: string;

  @IsString()
  @IsNotEmpty()
  nickname!: string;

  @IsOptional()
  @IsString()
  hostToken?: string;
}
