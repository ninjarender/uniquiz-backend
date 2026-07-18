import { IsNotEmpty, IsString } from 'class-validator';

/** Body of POST /banks and PATCH /banks/{bankId} (required name). */
export class BankNameDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}
