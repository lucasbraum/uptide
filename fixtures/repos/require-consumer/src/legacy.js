const S = require('synthetic');
const { VERSION } = require('synthetic');

const client = S.makeClient('https://example');
const mode = require('synthetic').VERSION;
register(require('synthetic'));

function register() {}
module.exports = { client, VERSION, mode };
