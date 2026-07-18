import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { GameMode } from '../../../generated/prisma/enums';

/** RoomSettings from common.yaml: mode + questionCount + timePerQuestionSeconds. */
export class RoomSettingsDto {
  @IsEnum(GameMode)
  mode!: GameMode;

  @IsInt()
  @Min(1)
  questionCount!: number;

  @IsInt()
  @Min(5)
  timePerQuestionSeconds!: number;
}

/** Body of POST /rooms (RoomCreate). */
export class RoomCreateDto {
  @IsUUID()
  bankId!: string;

  @IsString()
  @IsNotEmpty()
  hostNickname!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => RoomSettingsDto)
  settings!: RoomSettingsDto;
}
