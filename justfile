set fallback := true
repo_root := justfile_directory()

justfile-hygiene:
  #!/usr/bin/env bash
  set -euo pipefail
  if [ -e "{{repo_root}}/Justfile" ]; then
    echo "Remove Justfile; use lowercase justfile as the single canonical entrypoint." >&2
    exit 1
  fi

install: install-ts install-mcp

install-ts:
  direnv exec "{{repo_root}}" bun install

install-mcp:
  direnv exec "{{repo_root}}" sh -lc 'cd mcp-server && uv sync --dev'

typecheck:
  direnv exec "{{repo_root}}" bunx tsc --noEmit

test:
  direnv exec "{{repo_root}}" bun test tests/integration

mcp-test:
  direnv exec "{{repo_root}}" sh -lc 'cd mcp-server && uv run python -m pytest'

check: justfile-hygiene typecheck test mcp-test

setup-npm-trust:
  #!/usr/bin/env bash
  set -euo pipefail
  npm trust github --repository "dzackgarza/$(basename "{{repo_root}}")" --file publish.yml

publish: check
  direnv exec "{{repo_root}}" npm publish


# Bump patch version, commit, and tag
bump-patch:
    npm version patch --no-git-tag-version
    git add package.json
    git commit -m "chore: bump version to v$(node -p 'require("./package.json").version')"
    git tag "v$(node -p 'require("./package.json").version')"

# Bump minor version, commit, and tag
bump-minor:
    npm version minor --no-git-tag-version
    git add package.json
    git commit -m "chore: bump version to v$(node -p 'require("./package.json").version')"
    git tag "v$(node -p 'require("./package.json").version')"

# Push commits and tags to trigger CI release
release: check
    git push && git push --tags

