# Contributing to Stasher

Thank you for your interest in contributing to Stasher! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

Please be respectful and considerate of others when contributing to this project. We aim to foster an inclusive and welcoming community.

## How to Contribute

### Commit Style

Commit should follow this style:

[Semantic Commit Messages](https://gist.github.com/joshbuchea/6f47e86d2510bce28f8e7f42ae84c716)

Aka:

Format: `<type>(<scope>): <subject>`

`<scope>` is optional

## Example

```
feat: add hat wobble
^--^  ^------------^
|     |
|     +-> Summary in present tense.
|
+-------> Type: chore, docs, feat, fix, refactor, style, or test.
```

More Examples:

- `feat`: (new feature for the user, not a new feature for build script)
- `fix`: (bug fix for the user, not a fix to a build script)
- `docs`: (changes to the documentation)
- `style`: (formatting, missing semi colons, etc; no production code change)
- `refactor`: (refactoring production code, eg. renaming a variable)
- `test`: (adding missing tests, refactoring tests; no production code change)
- `chore`: (repository maintenance with no production code change)

### Reporting Bugs

If you've found a bug in Stasher, please create an issue using the bug report template. To ensure we can address your bug quickly, please:

1. Check if the bug has already been reported
2. Use the Bug Report template when creating a new issue on GitHub
3. Include as much detail as possible, including steps to reproduce, expected behavior, and your environment

### Suggesting Features

Have an idea for a new feature or improvement? We'd love to hear it! Please:

1. Check if the feature has already been suggested
2. Use the Feature Request template when creating a new issue on GitHub
3. Clearly describe the problem your feature would solve and how it should work

### Pull Requests

We welcome pull requests! Here's how to submit one:

1. Fork the repository
2. Create a new branch from `main`
3. Make your changes
4. Test your changes thoroughly
5. Submit a pull request (the PR template will load automatically)

## Development Setup

To set up the project for local development:

1. Clone your fork of the repository
2. Open your Chromium browser's extensions page
3. Enable developer mode
4. Choose **Load unpacked** and select the repository directory
5. After making changes, reload Stasher from the extensions page and test the affected behavior

## Project Structure

Stasher is a dependency-free Manifest V3 browser extension:

- `manifest.json`: Extension metadata, permissions, commands, and entry points
- `src/background/service-worker.js`: Tab stashing, toolbar, shortcut, context menu, and storage behavior
- `src/manager/manager.html`: Manager page structure
- `src/manager/manager.js`: Stash management, import/export, and undo behavior
- `src/manager/manager.css`: Manager page styles and system theme colors
- `assets/`: Extension icons and other static assets
- `.github/`: GitHub templates and configuration

## Adding New Features

To add a new feature:

1. Identify whether the change belongs in the background service worker or manager page
2. Follow the patterns already used in the relevant JavaScript, HTML, and CSS files
3. Update `manifest.json` only when the feature needs new permissions, commands, or extension entry points
4. Keep all functionality local and compatible with Chromium Manifest V3
5. Reload the extension and test your feature thoroughly before submitting a PR

## Code Style Guidelines

Please follow these guidelines for your code contributions:

- Match the existing JavaScript, HTML, and CSS style
- Use meaningful variable and function names
- Prefer `const` and `let` over `var` in JavaScript
- Add comments or JSDoc only where they clarify non-obvious behavior
- Maintain consistent naming conventions with the existing codebase
- Keep extension pages compatible with the content security policy in `manifest.json`

## Testing

Before submitting your changes, please test them thoroughly. Ensure:

1. Your feature works as expected
2. Your change doesn't break existing functionality
3. Your code doesn't generate new warnings or errors
4. Stashing and restoring both grouped and ungrouped tabs still works
5. Relevant manager actions, such as editing, deleting, undoing, importing, and exporting, still work
6. The extension reloads without errors on the Chromium extensions page

## Documentation

If you're adding new features or changing existing ones, please update the documentation accordingly. This includes:

- Comments explaining complex logic
- `README.md` when installation or user-facing behavior changes
- `manifest.json` when extension metadata, permissions, commands, or version information changes

## Questions?

If you have any questions about contributing, please open an issue with your question or reach out to the project maintainers.

Thank you for contributing to Stasher!