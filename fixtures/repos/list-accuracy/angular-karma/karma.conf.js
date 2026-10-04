// Synthetic configuration; discovery must never execute it.
module.exports = (config) => {
  config.set({
    frameworks: ['jasmine'],
    preprocessors: { '**/*.js': ['webpack', 'sourcemap'] },
    reporters: ['coverage', 'spec'],
    browsers: ['Chrome', 'ChromeHeadless'],
  });
};
