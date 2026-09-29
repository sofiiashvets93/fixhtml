# Public repository privacy

- Use synthetic, non-identifying fixtures for public tests and examples.
- Never commit, push, package, or deploy user-provided documents, slide decks,
  screenshots, or extracts from them. Do not include their names, text, counts,
  visual specifications, or other identifying details in tests, documentation,
  commit messages, pull requests, comments, or validation reports.
- Keep any authorized local testing with private files outside this repository.
  Do not copy private files into asset directories, even if Git ignores them:
  build and deployment tools can still copy ignored files.
- Before publishing, inspect the staged diff, outgoing commit history, PR text,
  and deployment/package contents. Report validation using generic descriptions.
- If private material is found in published history, report it clearly and clean
  the affected references. Do not claim that rewriting a branch purges hosting
  caches or third-party copies.
