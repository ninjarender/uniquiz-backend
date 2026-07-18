import { IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

/** Body of POST /banks/{bankId}/questions (QuestionInput, text required). */
export class CreateQuestionDto {
  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;

  @IsOptional()
  @IsString()
  referenceAnswer?: string;
}

/** Body of PATCH /questions/{questionId} (QuestionInput, all optional). */
export class UpdateQuestionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  text?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;

  @IsOptional()
  @IsString()
  referenceAnswer?: string;
}
