import { makeClient, Parser } from 'synthetic';
import { parse } from './lib/index.js';

// Instance method chain: `Client#get` reached through the type of `client`.
export async function chained(): Promise<number> {
  const client = makeClient('https://example');
  const item = await client.get('42');
  const parser = Parser.create();
  const { options, parse: parseAgain } = parser;
  parseAgain(item.id);
  return options.named.length + parse(item.id).tags.size;
}
