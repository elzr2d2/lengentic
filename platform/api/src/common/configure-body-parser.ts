import type { NestExpressApplication } from '@nestjs/platform-express';
import { INGEST_LIMITS } from '@lengentic/shared';
import { bodyParserErrorHandler } from './body-parser-error.middleware';

/**
 * §12 request-level limits: max request body 5 MB, body-not-valid-JSON — both HTTP 400,
 * never the platform's default 413 or a silent 500. Extracted out of `main.ts` so a test can
 * apply the exact same pipeline to a `Test.createTestingModule` app instead of only being
 * exercisable by booting the real server (see `configure-body-parser.spec.ts`).
 *
 * Must run before `app.init()`/`app.listen()` — see the call site's own comment on why the
 * app is created with `bodyParser: false` first.
 */
export function configureBodyParser(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: INGEST_LIMITS.maxRequestBodyBytes });
  app.use(bodyParserErrorHandler);
}
