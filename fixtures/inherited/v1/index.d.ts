/** v1 declares every member on the class itself, and a callable-namespace `export =` shape. */
export declare class Str {
  min(n: number): this;
  max(n: number): this;
  static create(): Str;
}
export interface Issue {
  code: string;
  message: string;
}
export declare class Failure {
  issues: Issue[];
}
