import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthCredentialsDto } from './dto/auth-credentials.dto';

const BCRYPT_ROUNDS = 10;

/**
 * Compared against when the email is unknown so that login timing does not
 * reveal whether an account exists.
 */
const DUMMY_HASH = bcrypt.hashSync(
  'invalid-password-placeholder',
  BCRYPT_ROUNDS,
);

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

  /**
   * Verifies email + password and returns a signed JWT (AuthToken).
   * 401 never says which of the two is wrong (contract: 401 on /auth/login).
   */
  async login(
    credentials: AuthCredentialsDto,
  ): Promise<{ accessToken: string }> {
    const email = credentials.email.toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true },
    });

    const passwordMatches = await bcrypt.compare(
      credentials.password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueToken(user);
  }

  /**
   * Returns the account behind a verified token (User schema: id + email).
   * 401 if the account no longer exists.
   */
  async getMe(userId: string): Promise<{ id: string; email: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return user;
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
