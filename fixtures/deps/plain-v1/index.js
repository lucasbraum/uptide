module.exports = function plain() {
  return 'plain';
};
module.exports.hello = (name) => `hi ${name}`;
module.exports.legacy = () => 'old';
