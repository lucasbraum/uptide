/** `export =` shape used by CommonJS packages: a class, a namespace merged onto it, one root. */
declare class Api {
  constructor(key: string);
  static version: string;
  /** Instance member and nested namespace share a name; they live in different spaces. */
  errors: typeof Api.errors;
  request(path: string): Promise<Api.Response>;
}
declare namespace Api {
  namespace errors {
    class ApiError extends Error {
      status: number;
    }
  }
  interface Response {
    ok: boolean;
    data?: unknown;
  }
}
export = Api;
