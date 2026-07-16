import { IsEmail, IsString, MinLength } from 'class-validator';

/** Body of POST /auth/register and /auth/login (schema AuthCredentials). */
export class AuthCredentialsDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
