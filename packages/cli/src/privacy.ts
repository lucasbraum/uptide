/**
 * The privacy statement, word for word the same in `--help` and in the README (a test
 * compares them). Change it only together with what the code does.
 */
export const PRIVACY = `Privacy:
  Analysis runs locally. Your code is sent only to the LLM provider (Anthropic), only
  for assisted fixes in \`uptide fix\`, and only with your own ANTHROPIC_API_KEY: for each
  site the rules cannot migrate, the finding, the enclosing function and the compiler
  error. \`uptide fix --no-llm\` turns assisted fixes off. No telemetry, no account.
  Other network use: your npm registry for package metadata and tarballs, and GitHub
  only when you pass \`fix --pr\` or run \`pr-body\`.
`;
