// @ts-check
async function load() {
  const m = await import('synthetic');
  return m.makeClient('https://example');
}
module.exports = { load };
