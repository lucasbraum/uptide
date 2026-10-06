// A synthetic pino-like logger (pino 9 shape): a callable export merged with a namespace,
// self-referencing and mutually recursive declarations, and two namespaces that re-export
// each other.
declare namespace logkit {
  export interface Logger {
    child(bindings: Bindings): Logger;
    level: string;
    parent?: Logger;
  }
  export interface Bindings {
    logger?: Logger;
    [key: string]: unknown;
  }
  export interface Node {
    edges: Edge[];
  }
  export interface Edge {
    from: Node;
    to: Node;
  }
  export type Tree = { value: string; children: Tree[] };
  export interface Options {
    level?: string;
  }
  export const levels: { info: number };
  export namespace ping {
    export import other = pong;
    export const name: 'ping';
  }
  export namespace pong {
    export import other = ping;
    export const name: 'pong';
  }
  // Nested callable export for `const { logkit } = require('logkit')`.
  export function logkit(options?: Options): Logger;
  export namespace logkit {
    export const levels: { info: number };
  }
}
declare function logkit(options?: logkit.Options): logkit.Logger;
export = logkit;
