import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { AuthCredentialsDto } from './dto/auth-credentials.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { JwtPayload } from './jwt-payload';

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

  /** GET /auth/me → 200 User | 401 missing or invalid token. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(
    @CurrentUser() payload: JwtPayload,
  ): Promise<{ id: string; email: string }> {
    return this.authService.getMe(payload.sub);
  }
}
