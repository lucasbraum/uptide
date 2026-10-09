import * as React from 'react';
import { useRef } from 'react';

export function Timer() {
  const timer = useRef<number>(undefined); // @uptide use-ref-argument at:useRef kind:signature path:TS2554 message:"Expected 1 arguments, but got 0."
  const handler = React.useRef<(...args: string[]) => void>(undefined); // @uptide use-ref-argument at:React.useRef kind:signature path:TS2554 message:"Expected 1 arguments, but got 0."
  const anything = useRef(undefined); // @uptide use-ref-argument at:useRef kind:signature path:TS2554 message:"Expected 1 arguments, but got 0."
  // Already has an argument: nothing to add.
  const input = useRef<HTMLInputElement>(null); // @uptide use-ref-argument keep at:useRef kind:signature path:TS2554 message:"Expected 1 arguments, but got 0."
  // Two calls on one line: the reported site is ambiguous, so the rule declines.
  const pair = [useRef<number>(), useRef<string>()]; // @uptide use-ref-argument keep at:useRef kind:signature path:TS2554 message:"Expected 1 arguments, but got 0."
  return { timer, handler, anything, input, pair };
}
