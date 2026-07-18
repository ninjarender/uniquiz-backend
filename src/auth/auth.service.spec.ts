import { ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  const userCreate = jest.fn();
  const signAsync = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: { user: { create: userCreate } } },
        { provide: JwtService, useValue: { signAsync } },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  describe('register', () => {
    const credentials = { email: 'Host@Example.com', password: 'password123' };

    it('creates a user with a bcrypt hash and returns an access token', async () => {
      userCreate.mockResolvedValue({
        id: 'user-id',
        email: 'host@example.com',
      });
      signAsync.mockResolvedValue('signed.jwt.token');

      const result = await service.register(credentials);

      expect(result).toEqual({ accessToken: 'signed.jwt.token' });
      const [createArgs] = userCreate.mock.calls[0] as [
        { data: { email: string; passwordHash: string } },
      ];
      expect(createArgs.data.email).toBe('host@example.com'); // lowercased
      expect(createArgs.data.passwordHash).not.toBe(credentials.password);
      await expect(
        bcrypt.compare(credentials.password, createArgs.data.passwordHash),
      ).resolves.toBe(true);
      expect(signAsync).toHaveBeenCalledWith({
        sub: 'user-id',
        email: 'host@example.com',
      });
    });

    it('throws ConflictException when email is already registered (P2002)', async () => {
      userCreate.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );

      await expect(service.register(credentials)).rejects.toThrow(
        ConflictException,
      );
      expect(signAsync).not.toHaveBeenCalled();
    });

    it('rethrows unexpected errors untouched', async () => {
      const dbDown = new Error('connection refused');
      userCreate.mockRejectedValue(dbDown);

      await expect(service.register(credentials)).rejects.toBe(dbDown);
    });
  });
});
