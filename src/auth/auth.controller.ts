import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthCredentialsDto } from './dto/auth-credentials.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** POST /auth/register → 201 AuthToken | 409 email already registered. */
  @Post('register')
  register(
    @Body() credentials: AuthCredentialsDto,
  ): Promise<{ accessToken: string }> {
    return this.authService.register(credentials);
  }

  /** POST /auth/login → 200 AuthToken | 401 invalid email or password. */
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(
    @Body() credentials: AuthCredentialsDto,
  ): Promise<{ accessToken: string }> {
    return this.authService.login(credentials);
  }
}
