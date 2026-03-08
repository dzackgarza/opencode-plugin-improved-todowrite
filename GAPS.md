# GAPS — improved-todowrite

## Remaining Gaps

### No mirroring into the built-in OpenCode todo store

`improved_todowrite` and `improved_todoread` use their own SQLite persistence layer keyed by
OpenCode `sessionID`. This is intentional for tree-native behavior, but it means OpenCode surfaces
that rely on the built-in flat todo store will not see the tree unless a separate projection layer
is added later.

**Current ramifications:**

- Built-in `session.todo(...)` still reads the upstream flat store, not the tree store
- Sidebar/session todo views will not automatically reflect the tree
- Tree state is canonical only through `improved_todowrite` and `improved_todoread`

### Local one-shot verification requires explicit plugin config selection

In this environment, running `/home/dzack/.opencode/bin/opencode run` from the plugin directory did
not automatically load `improved-todowrite/.config/opencode.json`. The intended local workflow is to
enter the plugin directory and use `direnv allow`, which exports `OPENCODE_CONFIG` and the
verification passphrase from
[`improved-todowrite/.envrc`](/home/dzack/opencode-plugins/improved-todowrite/.envrc). The explicit
`OPENCODE_CONFIG=...` form remains the fallback when `direnv` is unavailable.

**Verified command:**

```bash
cd /home/dzack/opencode-plugins/improved-todowrite
direnv allow
timeout 30 /home/dzack/.opencode/bin/opencode run --agent Minimal \
  "Use the improved_todowrite tool, not todowrite. Write a todo tree with top-level node id=phase-1, content='Ship persistence layer', status='pending', priority='high', and one child id=task-1, content='Design schema', status='completed', priority='high'. Then call improved_todoread. Reply with only the final tool output verbatim."
```

### Human TUI verification is still pending

Automated tests cover SQLite persistence, tree flattening/hydration, and FastMCP wrapper behavior.
A manual TUI pass is still needed to decide whether the current plain text display is sufficient for
humans or whether a derived top-level projection should be rendered differently.
