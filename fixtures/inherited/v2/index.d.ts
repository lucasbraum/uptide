/** v2 moves the same members onto bases and mixins (the zod 4 shape); nothing is removed. */
export interface _Str<T = string> {
  min(n: number): this;
  max(n: number): this;
  _kind?: T;
}
export declare class Base {
  static create(): Str;
}
export declare class Str extends Base implements _Str {}
export interface Str extends _Str {}
export interface Issue {
  code: string;
  message: string;
}
export interface _Failure {
  issues: Issue[];
}
export declare class Failure implements _Failure {}
export interface Failure extends _Failure {}
