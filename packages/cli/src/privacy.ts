/**
 * The privacy statement, word for word the same in `--help` and in docs/privacy.md (a test
 * compares them). Change it only together with what the code does.
 */
export const PRIVACY = `Privacy:
  Analysis runs locally. Code snippets go to your chosen LLM provider (Anthropic, OpenAI or Gemini), only
  for assisted fixes in \`uptide fix\`, and only with your own API key from ANTHROPIC_API_KEY,
  OPENAI_API_KEY or GEMINI_API_KEY: for each
  site the rules cannot migrate, the finding, the enclosing function and the compiler
  error. \`uptide fix --no-llm\` turns assisted fixes off. No account.
  \`check\` and \`verify\` load the \`typescript\` package your repository installs (resolved from its
  node_modules) to compile with, and never run your repository's scripts or other code outside
  \`fix\`'s verification step.
  Anonymous telemetry is off by default and asks for consent in an interactive terminal.
  Set UPTIDE_TELEMETRY=0 to disable it. No IP, code, paths or repo names are collected.
  Other network use: your npm registry for package metadata and tarballs, npm's advisory
  endpoint from \`list\` (public package names and installed versions; \`--no-advisories\` turns
  it off), PostHog EU only
  after telemetry opt-in, and GitHub when you pass \`fix --pr\` or run \`pr\` / \`pr-body\`.
`;
