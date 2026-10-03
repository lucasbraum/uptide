import { makeClient, VERSION } from 'synthetic';

export function boot(): string {
  const client = makeClient('https://example');
  void client;
  return VERSION;
}
