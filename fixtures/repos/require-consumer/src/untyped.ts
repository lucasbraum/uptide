// biome-ignore lint/suspicious/noExplicitAny: a legacy file where require() is untyped on purpose
declare const require: (id: string) => any;
const S = require('synthetic');
const { VERSION } = require('synthetic');

export const d = S.makeClient('https://example');
export const v = VERSION;
export const dyn = require(process.env.PKG_NAME ?? 'synthetic');
