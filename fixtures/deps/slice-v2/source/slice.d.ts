// The type-fest 5 shape: the same parameters, defaults and all, over new bodies.
export type CamelCaseOptions = { preserveConsecutiveUppercase?: boolean };

export type CamelCase<Type, Options extends CamelCaseOptions = {}> = Type extends string
  ? `${Options['preserveConsecutiveUppercase'] extends false ? Lowercase<Type> : Type}`
  : Type;

export type Slice<
  Array_ extends readonly unknown[],
  Start extends number = never,
  End extends number = never,
> = Array_ extends unknown ? ([End] extends [never] ? Array_ : readonly Array_[number][]) : never;
