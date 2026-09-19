import { AdvancedConsoleLogger } from 'typeorm';

export class QueryCountLogger extends AdvancedConsoleLogger {
  count = 0;

  constructor() {
    super(['query', 'error', 'warn']);
  }

  override logQuery(query: string, parameters?: unknown[]): void {
    this.count++;
    super.logQuery(query, parameters);
  }

  reset(): void {
    this.count = 0;
  }
}
