import type { Item, ParseOptions } from 'synthetic';
import { createParser, Level, Parser, parse as parseInput, VERSION } from 'synthetic';
import { Client } from 'synthetic/legacy';
import * as utils from 'synthetic/utils';

// direct call; alias call (`parse as parseInput`); construct; read; write; typeRef.
export function run(input: string): Item {
  const parser = new Parser();
  const first = parseInput(input);
  const second = parser.parse(input);
  const options: ParseOptions = { mode: 'loose', named: [first, second] };
  options.strict = true;
  console.log(VERSION, Level.High, parser.size, options.mode);
  const chunks = utils.chunk([first], 2);
  const legacy = new Client('host', 1);
  legacy.connect();
  return createParser(options).parse(chunks[0]?.[0]?.id ?? input);
}
