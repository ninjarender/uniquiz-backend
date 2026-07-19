import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Body of PATCH /answer-sets/{answerSetId} (AnswerSetPatch): every field
 * optional, but at least one must be present - the service enforces the
 * contract's minProperties: 1.
 */
export class AnswerSetPatchDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  options?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  correctIndex?: number;

  @IsOptional()
  @IsString()
  spareDistractor?: string;

  @IsOptional()
  @IsString()
  explanation?: string;
}
