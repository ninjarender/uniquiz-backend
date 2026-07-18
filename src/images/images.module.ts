import { mkdirSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImagesController } from './images.controller';
import { UPLOADS_DIR } from './images.constants';

// The uploads directory must exist before multer's diskStorage writes to it.
mkdirSync(UPLOADS_DIR, { recursive: true });

@Module({
  imports: [AuthModule],
  controllers: [ImagesController],
})
export class ImagesModule {}
