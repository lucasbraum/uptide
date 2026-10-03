/** A second block for the same module, pulled in by a reference directive. Merges into the first. */
declare module 'synthetic/ambient' {
  export interface Thing {
    b?: string;
  }
}
