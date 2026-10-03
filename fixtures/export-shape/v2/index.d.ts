export interface Options {
  limit?: number;
}
export interface Instance {
  resize(width: number): Instance;
}
export declare function cache(on: boolean): void;
declare function shape(input: string, options?: Options): Instance;
export default shape;
