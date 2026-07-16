import { ConflictException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthCredentialsDto } from './dto/auth-credentials.dto';

const BCRYPT_ROUNDS = 10;

/** Prisma unique-constraint violation (duplicate email). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /** Registers a host account and returns a signed JWT (AuthToken). */
  async register(
    credentials: AuthCredentialsDto,
  ): Promise<{ accessToken: string }> {
    const email = credentials.email.toLowerCase();
    const passwordHash = await bcrypt.hash(credentials.password, BCRYPT_ROUNDS);

    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash },
        select: { id: true, email: true },
      });
      return this.issueToken(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Email already registered');
      }
      throw error;
    }
  }

  private async issueToken(user: {
    id: string;
    email: string;
  }): Promise<{ accessToken: string }> {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
    });
    return { accessToken };
  }
}
