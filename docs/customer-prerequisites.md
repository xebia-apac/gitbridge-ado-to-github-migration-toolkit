# Customer Prerequisites – MVP

## Azure DevOps source
- Organization URL and project selection (one or comma-separated names; leave blank to discover all accessible projects).
- ADO PAT shared only through GitHub Actions Secrets, with read access to projects/teams, code, build and release definitions, and service endpoints for the selected scope. The least-privilege PAT scope for Git repository ACL reads is not conclusively stated by the ACL API reference; verify with your ADO administrator before adding a Security permission.
- Confirmation that selected projects and repositories are in discovery scope.
- Repository inventory, reported size, default branch, branch/tag/commit history, policies, permissions, pipelines, service connections, and LFS configuration reviewed.
- Source freeze/cutover plan, backup owner and rollback owner.

## GitHub target
- Target GitHub organization name and approval to create repositories.
- GitHub App installation token preferred, or fine-grained PAT with permission to create repositories and write contents in the target organization.
- Confirm target repository names and visibility (private by default).
- Confirm organization allows the required Actions workflows and token permissions.
- Configure protected Environment `migration-approval` with required reviewers.

## Runner and network
- GitHub-hosted runner with HTTPS access to Azure DevOps and GitHub; use hardened self-hosted runner only if private networking/proxy requires it.
- Sufficient temporary disk and time for the largest repository.
- Proxy/firewall allowlisting and certificate requirements confirmed.

## Scope exclusions in current MVP
Discovery inventories repository metadata, branch policies, repository ACLs, build/release definitions, and service connection metadata. These assets are not migrated by the Git mirror workflow. ADO PRs, work items, boards, variable groups, wikis, test plans, and artifacts require separate migration procedures. LFS detection checks tracked `.gitattributes`; it does not verify or transfer LFS objects. Service connection authorization values and other secret values are never exported; recreate credentials through an approved secure process.
