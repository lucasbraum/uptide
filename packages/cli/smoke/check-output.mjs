// Shared by the container and the fast formatter regression test: changes to the report
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
