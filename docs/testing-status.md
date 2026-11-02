# MVP Test Status

## Latest pre-push local run

- `npm test`: PASS (46 tests).
- `npm run check`: PASS.
- Workflow YAML parsed with Ruby's standard YAML parser: PASS.
- `actionlint`, `zizmor`, and `shellcheck` are not installed; no packages were installed for this audit.
- The workspace directory is not currently a Git repository; initialize/clone the intended remote before preparing a push.

## Executed locally

- Node.js syntax checks for runtime modules: PASS.
- Unit tests for CSV escaping: PASS.
- ADO client Basic PAT header behavior and secret-safe error handling with mocked API responses: PASS.
- ADO project selection, continuation-token pagination, commit offset pagination, release host routing, and rate-limit/timeout retry tests: PASS.
- Pagination overlap de-duplication, repeated/changing-token loop guards, malformed collection rejection, retry exhaustion, and actual AbortSignal timeout tests: PASS.
- Mocked adapters for repositories, refs/tags, branch policies, repository ACL permissions, build/release pipelines, service connections, and LFS attribute inspection: PASS.
- JSON/CSV tests verify service URL credentials in userinfo, query, fragment, and path are removed; commit, build, release, service connection, and policy secret-bearing fields are excluded: PASS.
- Organization/project/repository status rollup and CSV summary status consistency tests: PASS.
- Bounded LFS attribute concurrency, tree-entry, directory-request, and attribute-file limits: PASS.
- GitHub API 404 handling and 403 failure handling with mocked responses: PASS.
- Local Git mirror fixture: PASS using temporary bare repositories with 23 commits, two branches, two tags, matching source/target ref object IDs, and commit history count verification.
- Empty source/target, rejecting pre-receive hook, existing-target refusal, clone/push auth-error redaction, and askpass cleanup cases: PASS. Auth failures are simulated; no ADO/GitHub servers are contacted.
- GitHub client repository lookup/creation, existing-target refusal, redirect rejection, rate-limit retry, and branch/tag Link pagination are tested with mocked responses.

## Not yet executed

- Live Azure DevOps organization discovery (requires customer ADO URL and PAT).
- Discovery against projects with very large histories, large item trees, and organization-specific permissions.
- Live GitHub organization repository creation and push (requires target org and appropriately permissioned token).
- Live ADO-to-GitHub migration of a disposable test repository.
- GitHub organization settings, branch protection/rulesets, team mapping, variables, and repository access configuration; these adapters are not implemented.
- LFS transfer, PR/work item/pipeline/configuration migration.

A local Git fixture validates mirror mechanics only. Mocked adapter tests validate request construction and projection behavior, not API compatibility, PAT permissions, result completeness, or connectivity in a customer's tenant. LFS reporting detects `.gitattributes` configuration; it does not validate LFS object transfer.
