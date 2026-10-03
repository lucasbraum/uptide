export interface Item {
  id: string;
  /** @deprecated use id */
  legacyId?: string;
  tags: Set<string>;
}
