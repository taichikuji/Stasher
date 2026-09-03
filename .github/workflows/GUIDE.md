# Release workflow

Follow this checklist in order. A release must be built from `main`, pass the
automated checks, and have no uncommitted changes before its tag is created.

## Commit format

Use the format defined in [CONTRIBUTING.md](../CONTRIBUTING.md):

```text
<type>(<scope>): <subject>
```

The scope is optional. Use a lowercase type (`feat`, `fix`, `docs`, `refactor`,
`style`, `test`, or `chore`) and a short present-tense subject.

Examples:

```text
feat: preserve pinned tabs during restoration
fix(manager): rank stash title matches first
chore: bump version to 2.2.0
```

Do not use `Bump version ...` without a commit type.

## 1. Prepare and test

1. Checkout `main` and make sure the intended changes are present.
2. Run the automated suite:

   ```bash
   node --test
   ```

3. Run a whitespace check:

   ```bash
   git diff --check
   ```

4. Load the unpacked extension in Chrome and at least one other Chromium-based
   browser such as Brave or Edge. Check toolbar and keyboard stashing, badge
   updates, grouped and loose-tab restoration, import/export, and behavior
   after restarting the browser.

5. Commit any pending product changes with a correctly formatted commit message.

## 2. Bump the version

Update only the `version` field in `manifest.json` to the next semantic version:

- patch: fixes, tests, documentation, and maintenance;
- minor: backward-compatible user-facing features;
- major: breaking behavior or compatibility changes.

Confirm the version and tree state:

```bash
rg -n '\"version\"' manifest.json
git diff --check
git status --short
```

The version commit must use the `chore:` type:

```bash
git add manifest.json
git commit -m "chore: bump version to X.Y.Z"
git push origin main
```

Replace every `X.Y.Z` above with the exact value in `manifest.json`.

## 3. Tag the release

Create and push an annotated tag that exactly matches the manifest version:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Do not create the tag while `git status --short` reports changes. Release tags
must be created from the version-bump commit on `main`.

## 4. Monitor the build

The tag push starts the GitHub Actions workflow. It will:

- run the browser unit tests;
- read the version from `manifest.json`;
- package the Chromium extension;
- upload the package as a workflow artifact.

Monitor the run in the [Actions tab](https://github.com/taichikuji/Stasher/actions).

## 5. Verify the release

After the workflow completes successfully, confirm that the generated archive
named `Stasher_X.Y.Z.chromium.zip` is attached to the automated GitHub Release
on the [Releases page](https://github.com/taichikuji/Stasher/releases).
