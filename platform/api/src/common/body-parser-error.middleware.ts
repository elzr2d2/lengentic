import type { NextFunction, Request, Response } from 'express';
import type { ErrorBody } from './all-exceptions.filter';

/**
 * §12's two request-level rejections that occur BEFORE any NestJS routing runs: "body
 * exceeds max request size" and "body is not valid JSON". Both must produce HTTP 400 — the
 * platform default for the first is 413, and neither error is a NestJS `HttpException`, so
 * `AllExceptionsFilter` never sees them (it only classifies exceptions Nest's own pipeline
 * throws) and they would otherwise surface as an unhandled 500.
 *
 * `express`/`body-parser` are imported here as TYPES ONLY (`import type`), resolved against
 * `@types/express`, a direct devDependency of this package. The neither is imported as a
 * runtime value — `@nestjs/platform-express`'s `useBodyParser` (main.ts) is the only runtime
 * body-parser surface this package touches, deliberately: `express` itself is a transitive
 * dependency of `@nestjs/platform-express`, not a direct one, and this lane's forbidden_paths
 * excludes `package.json` from this attempt.
 *
 * Registered via `app.use()` immediately after the JSON body parser and nothing else — an
 * Express error-handling middleware (4-argument arity, which Express detects structurally)
 * only observes errors from middleware registered BEFORE it, so this intentionally sits
 * between the parser and everything Nest itself wires up at `listen()`.
 */
export function bodyParserErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const classified = classify(err);
  if (classified === undefined) {
    next(err);
    return;
  }

  const body: ErrorBody = {
    statusCode: 400,
    error: 'Bad Request',
    message: classified,
    path: req.url,
    timestamp: new Date().toISOString(),
  };
  res.status(400).json(body);
}

function classify(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  const status =
    'status' in err ? err['status'] : 'statusCode' in err ? err['statusCode'] : undefined;
  const type = 'type' in err ? err['type'] : undefined;

  if (type === 'entity.too.large' || status === 413) {
    return 'request body exceeds the maximum size';
  }
  if (type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return 'request body is not valid JSON';
  }
  return undefined;
}
