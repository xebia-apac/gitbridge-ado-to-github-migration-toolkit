# Architecture

1. **Discovery layer (implemented):** The JavaScript runtime uses Azure DevOps REST APIs to enumerate accessible projects and selected-project repositories, branches, tags, commits, policies, repository ACLs, build/release definitions, service connection metadata, repository size, and bounded default-branch `.gitattributes` LFS configuration.
2. **Assessment layer (partial):** Discovery reports carry counts, adapter statuses, and LFS configuration indicators. They do not prove complete access, LFS object availability, or migration readiness.
3. **Execution layer (implemented for one repository):** A manual, approval-gated workflow uses `git clone --mirror` and `git push --mirror`. Existing GitHub targets are refused; there is no bulk migration workflow.
4. **GitHub configuration layer (not implemented):** The current REST client can inspect/create repositories and list refs. Organization settings, branch protection/rulesets, teams, variables, and repository access mapping are not configured by this toolkit.
5. **Validation layer (partial):** The current workflow checks branch/tag names. It does not compare complete commit-object parity, LFS objects, repository settings, or migrated asset counts.
6. **Reporting layer (implemented for JSON/CSV):** Discovery and workflow reports are uploaded as artifacts. Markdown/HTML generation and a consolidated ZIP report are not implemented. Credential-bearing fields are excluded from discovery projections.

## Safety controls
- Least-privilege credentials and short-lived GitHub App tokens.
- `workflow_dispatch` for migration, protected environment approval, explicit confirmation.
- PATs are sent only in authenticated ADO request headers or temporary askpass environment variables, never in the current JavaScript runtime's remote URLs.
- Service connection URLs are reduced to origin; authorization and data payloads are omitted from discovery reports.
- No mirror push to existing destination by default.
- Source freeze, backup and rollback plan required for production cutover.
- Pin third-party actions to full commit SHAs before production use.
