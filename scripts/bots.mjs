// The bots that open pull requests here, by the login GitHub records as a pull request's
// opener: a contributor cannot set it, so it is what every exemption keys on.

/** The GitHub App that opens the Version Packages pull request (docs/releasing.md). */
export const RELEASE_APP = 'uptide-release';
export const RELEASE_BOT = `${RELEASE_APP}[bot]`;
export const DEPENDABOT = 'dependabot[bot]';

/**
 * Each bot's commit address. A bot's own commits in its own pull request need no sign-off
 * (scripts/dco.mjs). An app's user id is assigned when it is created, so its address is
 * matched whatever the id: the opener, which only the app can be, is what is checked.
 */
export const BOTS = {
  [DEPENDABOT]: '49699333+dependabot[bot]@users.noreply.github.com',
  'github-actions[bot]': '41898282+github-actions[bot]@users.noreply.github.com',
  [RELEASE_BOT]: /^\d+\+uptide-release\[bot\]@users\.noreply\.github\.com$/,
};
