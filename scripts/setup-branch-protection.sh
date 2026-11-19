#!/usr/bin/env bash
# Protects the default branch of the GitHub repo for this checkout with a ruleset:
# changes must go through a pull request, and the "CI ok" check must pass before merging.
# Requires the GitHub CLI (`gh`) logged in with admin rights on the repository.
# Note: rulesets on private repositories need a paid GitHub plan; public repos are free.
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
echo "Applying 'Protect main' ruleset to $repo"

existing="$(gh api "repos/$repo/rulesets" -q '.[] | select(.name == "Protect main") | .id' || true)"
method=POST
path="repos/$repo/rulesets"
if [ -n "$existing" ]; then
  method=PUT
  path="repos/$repo/rulesets/$existing"
fi

gh api --method "$method" "$path" --silent --input - <<'JSON'
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "CI ok" }]
      }
    }
  ]
}
JSON

# Squash-merge only, and delete branches after merging.
gh api --method PATCH "repos/$repo" \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F allow_auto_merge=true >/dev/null

echo "Done: main requires a pull request with a passing 'CI ok' check."
