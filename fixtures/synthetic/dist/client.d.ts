import type { Item } from './item.js';
export declare class Client {
  constructor(url: string);
  get(id: string): Promise<Item>;
}
export declare function createClient(url: string): Client;
