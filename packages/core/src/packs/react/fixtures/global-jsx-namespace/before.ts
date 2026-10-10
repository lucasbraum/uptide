import type * as React from 'react';

export type Icons = Record<string, JSX.Element>; // @uptide global-jsx-namespace at:JSX kind:type path:TS2503 message:"Cannot find namespace 'JSX'."
export type Missing = Other.Element; // @uptide global-jsx-namespace keep at:Other kind:type path:TS2503 message:"Cannot find namespace 'Other'."
export type Scoped = React.JSX.Element;
