/** A different Client than the root one: same name, different declaration. */
export declare class Client {
  constructor(host: string, port: number);
  connect(): void;
}
export declare function noop(): void;
