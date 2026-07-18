import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Payload of the submit_answer event (asyncapi SubmitAnswerPayload). */
export class SubmitAnswerDto {
  @IsString()
  @IsNotEmpty()
  gameId!: string;

  @IsInt()
  @Min(0)
  questionIndex!: number;

  @IsInt()
  @Min(0)
  @Max(3)
  selectedOptionIndex!: number;

  /** true - auto-submission of the last chosen option on timeout. */
  @IsOptional()
  @IsBoolean()
  auto?: boolean;
}
