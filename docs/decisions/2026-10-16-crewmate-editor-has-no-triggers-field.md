# The crewmate editor dialog has no Triggers field; triggers stay editable on the Agents page.

Decided by: dodgeblaster (maintainer)
Date: 2026-10-16

## Decision
The crewmate editor dialog (the New editor, now the only crewmate editing
experience) does not expose a Triggers field. The trigger feature is retained
and stays editable on the Agents page.

## Why
Making the New editor the only crewmate editing experience is a deliberate
simplification of what that dialog exposes, and Triggers is intentionally left
out of it. The feature is not removed: `useCrewEditor` still owns the triggers
load, save and dirty-tracking state, and `TriggersField` still renders on the
Agents page (`KiroCrewAgentsPage` → `CrewRoutingPane`), so a user who sets when
a crewmate is picked still has a place to do it.

## Evidence
- https://github.com/kirodotdev/KiroCrew/pull/19257#issuecomment-6219151648 (maintainer restatement)
- https://github.com/kirodotdev/KiroCrew/pull/19257 (the PR making the change)
