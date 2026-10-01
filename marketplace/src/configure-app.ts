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
    const title = ({ 400: 'Bad Request', 404: 'Not Found', 422: 'Unprocessable Entity' } as Record<number, string>)[status] || 'Internal Server Error';
    response.status(status).type('application/problem+json').json({ type: `https://marketplace.example/problems/${status}`,
      title, status, detail: status >= 500 ? title : error.message, instance: context.getRequest().originalUrl });
  }
}
export function configureApp(app: INestApplication): void {
  app.use(express.json());
  app.use(OpenApiValidator.middleware({ apiSpec: fileURLToPath(new URL('../openapi/openapi.yaml', import.meta.url)),
    validateRequests: true, validateResponses: true, ignorePaths: /^\/(health|db-health)(\?|$)/ }));
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
}
