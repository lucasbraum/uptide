/**
 * Who migrates a site, in the words every report uses. Before a fix (`check`, `plan`): what
 * can be done; after it (`fix`): what was done.
 */
export const BY = {
  rule: (n: number): string => `${n} auto-fixable`,
  agent: (n: number): string => `${n} ${n === 1 ? 'needs' : 'need'} the agent (LLM)`,
  ruleTag: 'auto-fixable',
  agentTag: 'needs the agent (LLM)',
  ruleDone: (n: number): string => `${n} auto-fixed`,
  agentDone: (n: number): string => `${n} fixed by the agent (LLM)`,
  ruleDoneTag: 'auto-fixed',
  agentDoneTag: 'by the agent (LLM)',
} as const;
