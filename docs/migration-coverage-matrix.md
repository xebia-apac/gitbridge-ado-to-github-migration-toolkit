# Migration Coverage Matrix

| ADO asset | Discovery | Migration approach | Validation |
|---|---|---|---|
| Projects and repositories | Paginated accessible projects; all or selected projects; repository metadata and reported size | Existing Git mirror workflow | Discovery completeness depends on PAT access |
| Git refs/history | Branch/tag refs and commit history from ADO APIs; local mirror fixture verifies multiple commits and refs | `git clone --mirror` / `git push --mirror`, one repository per workflow run | Post-migration workflow compares branch/tag names only; object parity is not verified |
| Branches/tags/commits | Paginated refs; commits use `$skip`/`$top` | Git mirror | Ref names/object IDs are inventoried; full source/target object comparison is not implemented |
| Git LFS | Bounded default-branch scan of `.gitattributes` for `filter=lfs`; reported repository size | Dedicated LFS migration not implemented | LFS object availability is always `NOT_VERIFIED` |
| Pull requests | Not implemented | Not implemented | Not implemented |
| Branch policies | Paginated policy configurations with allowlisted settings | Mapping to rulesets/branch protection not implemented | Discovery only |
| Repository permissions | Git Repositories ACL descriptors and allow/deny masks, when authorized | Team/role mapping not implemented | Discovery only; ACL scope still needs tenant permission verification |
| Build pipelines | Paginated metadata projection; secret-bearing definition bodies omitted | Conversion to GitHub Actions not implemented | Discovery only |
| Release pipelines | Paginated metadata and environment names; variables omitted | Conversion to GitHub Actions not implemented | Discovery only |
| Variable groups/secrets | Not implemented | Not implemented; recreate secrets through approved secure process | Not implemented |
| Service connections | ID/name/type/sanitized URL/readiness only; authorization and data fields omitted | Recreate using GitHub App/OIDC/approved credentials | Connection test |
| Work items/boards | Not implemented | Not implemented | Not implemented |
| Environments/approvals | Not implemented | Not implemented | Not implemented |

Git mirror only migrates Git repository data. Discovery metadata is not migrated. GitHub organization settings, branch protection, teams, variables, and repository access configuration are not implemented. API sections can be unavailable when the PAT lacks the corresponding read permissions.
