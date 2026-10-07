import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter, type INestApplication } from '@nestjs/common';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { fileURLToPath } from 'node:url';

@Catch()
class ProblemFilter implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse();
    const status = error instanceof HttpException ? error.getStatus() : Number.isInteger(error.status) ? error.status : 500;
    const title = ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 422: 'Unprocessable Entity' } as Record<number, string>)[status] || 'Internal Server Error';
    response.status(status).type('application/problem+json').json({ type: `https://marketplace.example/problems/${status}`,
      title, status, detail: status >= 500 ? title : error.message, instance: context.getRequest().originalUrl });
  }
}
export function configureApp(app: INestApplication): void {
  app.use(express.json());
  // Signed bearer identity and ownership are enforced by OrderAccessService;
  // OpenAPI still validates request bodies, headers and response schemas.
  app.use(OpenApiValidator.middleware({ apiSpec: fileURLToPath(new URL('../openapi/openapi.yaml', import.meta.url)),
    validateRequests: true, validateResponses: true, validateSecurity: false, ignorePaths: /^\/(health|db-health)(\?|$)/ }));
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
}
