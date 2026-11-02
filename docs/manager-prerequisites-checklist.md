# Manager / Customer Input Checklist – Pilot Migration

Please confirm/provide through approved secure channels:

## ADO source
- [ ] Azure DevOps organization URL.
- [ ] Project name(s) and exact repository names in pilot scope; leave project selection blank to discover all accessible projects or provide comma-separated project names.
- [ ] ADO PAT owner and expiry; PAT stored only as GitHub Actions secret `ADO_PAT`.
- [ ] PAT read access: projects/teams, code, build/release definitions, and service endpoints for the selected scope. Verify the least-privilege ACL permission with an ADO administrator; do not assume Security (manage) is required.
- [ ] Confirm repo sizes, LFS usage, submodules and any unusually large history.
- [ ] ADO source freeze/cutover expectation and backup/rollback owner.

## GitHub target
- [ ] Target GitHub organization name and Enterprise Cloud/Server type.
- [ ] Approval to create private target repositories.
- [ ] GitHub App installation preferred; token stored as `GH_MIGRATION_TOKEN`.
- [ ] Token permissions: create repositories in target organization and write repository contents; add only the additional administration/team/ruleset permissions required by later configuration scope.
- [ ] Target naming convention, team mapping and repository visibility.
- [ ] Protected GitHub Environment `migration-approval` and required reviewer(s).

## Execution environment
- [ ] GitHub-hosted runner allowed, or self-hosted runner details if private network/proxy is required.
- [ ] Firewall/proxy allowlisting for Azure DevOps and GitHub HTTPS endpoints.
- [ ] Sufficient runner disk/time for largest repository.
- [ ] Agreed pilot window and customer technical contact for validation.

## Scope confirmation
- [ ] Confirm discovery scope for Git data, policies, repository permissions, build/release definitions, and service connection metadata.
- [ ] Confirm migration scope separately; Git mirror does not migrate ADO PRs, work items, pipelines, policies, permissions, service connections, variable groups, wikis, test plans or artifacts.
- [ ] Confirm whether LFS is in use and approve separate LFS transfer/validation if needed.
- [ ] Confirm acceptance criteria: branch/tag parity, commit history verification, target settings, application build/test and owner sign-off.

Never send PATs, passwords, private keys or secret values over email/chat or include them in reports. Use approved secret sharing and GitHub Actions Secrets.
