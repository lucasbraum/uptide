import type { Item } from './item.js';
export declare class Client {
  constructor(url: string);
  get(id: string): Promise<Item>;
}
export interface ClientOptions {
  timeout: number;
}
/** v2: a required options parameter. */
export declare function createClient(url: string, options: ClientOptions): Client;
