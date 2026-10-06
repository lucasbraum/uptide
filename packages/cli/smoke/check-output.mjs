// Shared by the container and the fast regression tests: changes to the reports
// must not leave the packed-CLI smoke test expecting an older terminal design.
export function checkReportFailures(output, fixture, manager) {
  const header = `uptide check · smoke-${fixture} · ${manager} ·`;
  const stripe =
    /stripe(?: \([^)]+\))?\s+14\.25\.0 → 22\.6\.2\s+8 majors behind · (?:--target|latest on npm)\s+verified\s+✗ \d+ breaking/;
  return [
    ...(!output.includes(header) ? [`${fixture} check: expected "${header}"\n${output}`] : []),
    ...(!stripe.test(output) ? [`${fixture} check: expected ${stripe}\n${output}`] : []),
  ];
}

// `list --json`: one entry per package, workspaces on different versions in its versions[].
export function listReportFailures(listed, manager) {
  const failures = [];
  const fail = (what) => failures.push(`${manager} list: ${what}`);
  if (!listed.packages.some((p) => p.name === 'zod' && p.usage.files > 0))
    fail('expected zod with usage');
  const keys = listed.packages.map((p) => JSON.stringify([p.name, p.registryName ?? p.name]));
  if (new Set(keys).size !== keys.length) fail('expected one entry per package');
  for (const p of listed.packages.filter((p) => p.versions)) {
    const versions = p.versions.map((v) => v.version);
    if (versions.length < 2 || new Set(versions).size !== versions.length)
      fail(`${p.name}: versions[] needs two or more distinct versions`);
    if (p.current !== versions[0]) fail(`${p.name}: current must be the oldest version`);
    if (p.versions.some((v) => !v.workspaces.length)) fail(`${p.name}: a version has no workspace`);
  }
  return failures;
}
