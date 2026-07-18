/** Local uploads directory (MVP: local disk behind nginx). */
export const UPLOADS_DIR = process.env.UPLOADS_DIR ?? './uploads';

/** Public URL prefix under which uploads are served as static files. */
export const UPLOADS_URL_PREFIX = '/uploads';

/** Image size limit; contract: 413 when exceeded (limit value was TBD -> 5 MB). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Accepted image mime types. */
export const IMAGE_MIME_PATTERN = /^image\/(png|jpe?g|gif|webp)$/;
