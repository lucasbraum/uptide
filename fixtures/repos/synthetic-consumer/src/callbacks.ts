import { type Item, type ParseOptions, parse, type Visitor } from 'synthetic';

// Callback implementations: object-literal methods, a function expression, and a class.
export function withHooks(input: string): Item {
  const options: ParseOptions = {
    mode: 'auto',
    named: [],
    hooks: {
      onStart() {},
      onEnd: (result) => console.log(result.id),
      // Receives options from the library: `opts.mode` is a read.
      onConfigure: (opts) => {
        if (opts.mode === 'strict') console.log('strict');
      },
      // Returns options to the library: `mode` here is a write.
      configure: () => ({ mode: 'loose', named: [] }),
    },
  };
  return parse(input, options);
}

export class MyVisitor implements Visitor {
  readonly name = 'mine';
  visit(item: Item): void {
    parse(item.id);
  }
}
