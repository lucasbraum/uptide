// The same logger at its next major (pino 10 shape): the namespace exports itself, as
// `default` and under its own name, instead of a nested copy. `Logger#parent` is gone and
// `Options#timestamp` is new.
declare namespace logkit {
  export interface Logger {
    child(bindings: Bindings): Logger;
    level: string;
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
    timestamp?: boolean;
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
  export { logkit as default, logkit };
}
declare function logkit(options?: logkit.Options): logkit.Logger;
export = logkit;
