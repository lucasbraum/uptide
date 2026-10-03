declare function shape(input: string, options?: shape.Options): shape.Instance;
declare namespace shape {
  interface Options {
    limit?: number;
  }
  interface Instance {
    resize(width: number): Instance;
  }
  function cache(on: boolean): void;
}
export = shape;
