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

# Start an isolated OpenCode server from .config/ so the plugin symlink is
# auto-discovered, run integration tests, then tear everything down.
# Server management lives here, not in test code. Tests read OPENCODE_BASE_URL.
test:
  #!/usr/bin/env bash
  set -euo pipefail

  config_dir="{{repo_root}}/.config"
  test_config="{{repo_root}}/tests/integration/test-opencode.json"
  xdg_root=$(mktemp -d "/tmp/opencode-todowrite-test-XXXXXXXXXX")
  config_home="$xdg_root/config"
  mkdir -p "$config_home/opencode" "$xdg_root/cache" "$xdg_root/state"

  # Copy test agent config into isolated XDG dir so the server uses it.
  cp "$test_config" "$config_home/opencode/opencode.json"

  # Find a free port.
  port=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); p=s.getsockname()[1]; s.close(); print(p)")
  base_url="http://127.0.0.1:$port"
  server_log="$xdg_root/server.log"

  cleanup() {
    if [[ -n "${server_pid:-}" ]]; then
      kill "$server_pid" 2>/dev/null || true
      wait "$server_pid" 2>/dev/null || true
    fi
    rm -rf "$xdg_root"
  }
  trap cleanup EXIT

  # Start server from .config/ so .opencode/plugins/ symlinks are discovered.
  (cd "$config_dir" && \
    XDG_CONFIG_HOME="$config_home" \
    XDG_CACHE_HOME="$xdg_root/cache" \
    XDG_STATE_HOME="$xdg_root/state" \
    opencode serve --hostname 127.0.0.1 --port "$port" --print-logs --log-level INFO \
      > "$server_log" 2>&1) &
  server_pid=$!

  # Wait for server ready.
  deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if grep -q "opencode server listening on $base_url" "$server_log" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "Server exited early. Logs:" >&2
      cat "$server_log" >&2
      exit 1
    fi
    sleep 0.2
  done

  OPENCODE_BASE_URL="$base_url" \
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
