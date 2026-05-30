# Golf Scorecard — Claude Instructions

## Mandatory for every change to index.html

These two steps are **required** in the same commit as the app change.
The pre-push hook will block the push if either is missing.

### 1. Tests
Add or update tests in `test.js` that cover the changed logic.
Run `node test.js` to confirm all pass before committing.

- New functions copied into the test stubs section go after the existing pure-function stubs.
- New test suites go just before the `// PRINT RESULTS` comment at the end.

### 2. What's New
Add an entry to `renderChangelog()` in `index.html`.
- Use `entry('new', icon, title, desc)` for features.
- Use `entry('fix', icon, title, desc)` for bug fixes.
- Place it at the **top** of the most recent `section('Month Year', [...])` call.

## Project structure

| File | Purpose |
|------|---------|
| `index.html` | Entire app — HTML + CSS + JS in one file |
| `test.js` | Node.js test suite; functions under test are copied in as stubs |
| `.githooks/pre-push` | Runs tests; blocks pushes missing tests or changelog entry |
| `sw.js` | Service worker (PWA offline cache) |

## Format rules

- No comments unless the *why* is non-obvious.
- No new files unless strictly necessary — edit `index.html` and `test.js`.
- Keep string concatenation style consistent with surrounding code (the file mixes template literals and `+` concatenation in different sections).
