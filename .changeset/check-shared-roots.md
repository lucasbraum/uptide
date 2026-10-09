---
"uptide": minor
---

`check` reports one breaking finding when call sites in different workspaces trace back to
the same local declaration (a parameter or prop whose type names something from the upgraded
package): the finding is anchored at the declaration, where the one edit is, and the call
sites are listed under it as evidence with an `N call sites in M workspaces` line, in the
terminal, the HTML report and the JSON report. Before, a site alone in its workspace stayed a
finding of its own, so a hook typed `RefObject<HTMLElement>` and called from three
workspaces was three findings plus the one that mattered. The JSON report gains `root` on
call-site findings and `workspace` on evidence sites; nothing is renamed or removed. The pack
test scorer counts the anchor as the predicted site and never the evidence under it.
