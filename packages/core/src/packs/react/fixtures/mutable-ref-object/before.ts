import * as React from 'react';
import type { MutableRefObject } from 'react';

export type Handle = {
  timer: React.MutableRefObject<number | undefined>; // @uptide mutable-ref-object at:React.MutableRefObject kind:deprecated path:MutableRefObject
  // Imported by name: the import needs RefObject beside it, which is not the reported site.
  data: MutableRefObject<string>; // @uptide mutable-ref-object keep at:MutableRefObject kind:deprecated path:MutableRefObject
  // Already the new type.
  box: React.RefObject<HTMLDivElement | null>;
};
