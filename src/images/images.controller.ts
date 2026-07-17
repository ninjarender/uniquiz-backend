import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { diskStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MIME_PATTERN,
  UPLOADS_DIR,
  UPLOADS_URL_PREFIX,
} from './images.constants';

/**
 * POST /images - host uploads a question image (multipart field "file").
 * 201 {url} | 400 not an image | 401 | 413 over the size limit.
 * MVP storage: local disk served as static files (nginx in production).
 */
@UseGuards(JwtAuthGuard)
@Controller('images')
export class ImagesController {
  constructor(private readonly config: ConfigService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOADS_DIR,
        filename: (_request, file, callback) =>
          callback(null, `${randomUUID()}${extname(file.originalname)}`),
      }),
      limits: { fileSize: IMAGE_MAX_BYTES },
      fileFilter: (_request: Request, file, callback) => {
        if (!IMAGE_MIME_PATTERN.test(file.mimetype)) {
          callback(
            new BadRequestException('Only image uploads are allowed'),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File): { url: string } {
    if (!file) {
      throw new BadRequestException('Field "file" with an image is required');
    }
    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    return { url: `${base}${UPLOADS_URL_PREFIX}/${file.filename}` };
  }
}
