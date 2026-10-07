export interface Module {
  type: string;
}
export interface Backend<Options = object> extends Module {
  init(options: Options): void;
}
export type Namespace = string | readonly string[];
export type NsByOptions<Ns extends Namespace, TOpt> = TOpt extends { ns: infer N } ? N : Ns;
export type KeyWithContext<Key, TOpt> = TOpt extends { context: string } ? `${Key & string}_ctx` : Key;
