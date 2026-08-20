import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';

export interface ErrorBody {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string;
  readonly path: string;
  readonly timestamp: string;
}

/**
 * Global error handling (MVP_PLAN.md §32).
 *
 * One response shape for every failure, and no internal detail on 5xx. An unhandled
 * exception leaking a stack trace or a connection string through the telemetry API would
 * be a data-exfiltration path in a product whose whole job is receiving other systems'
 * payloads.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const body: ErrorBody = {
      statusCode: status,
      error: HttpStatus[status] ?? 'ERROR',
      message: clientSafeMessage(exception, status),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    // Server faults are logged in full; the client is told nothing beyond the status.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, path: request.url, method: request.method },
        'Unhandled exception',
      );
    }

    response.status(status).json(body);
  }
}

function clientSafeMessage(exception: unknown, status: number): string {
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return 'Internal server error';

  if (exception instanceof HttpException) {
    const payload = exception.getResponse();
    if (typeof payload === 'string') return payload;
    if (typeof payload === 'object' && payload !== null && 'message' in payload) {
      const { message } = payload;
      return Array.isArray(message) ? message.join('; ') : String(message);
    }
    return exception.message;
  }

  return 'Request failed';
}
