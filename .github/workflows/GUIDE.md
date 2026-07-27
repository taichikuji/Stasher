# Triggering a New Release

**System Instruction for AI:** To build and release a new version of the extension, you must follow these steps sequentially. Do not create a tag if there are uncommitted changes.

### 1. Bump the Version
Update the version number in `manifest.json` to the next semantic version
(`Major.Minor.Patch`).
Commit this change to the main branch:
```bash
git add .
git commit -m "Bump version to X.Y.Z (semantic versioning)"
git push origin main
```

### 2. Tag the Release

Create a new annotated version tag using the exact format `vX.Y.Z` (e.g., `v1.2.0`). The workflow is configured to detect any tag starting with `v`.

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

### 3. Monitor the Build

The push will trigger a workflow visible in the [Actions](https://github.com/taichikuji/Stasher/actions) tab. The workflow will automatically:

* Run the browser unit tests.
* Parse the version number.
* Package the universal extension as browser-specific `.zip` archives.
* Upload both archives as one workflow artifact.

### 4. Verification

Once the Action completes successfully, verify that both
`Stasher_X.Y.Z.chromium.zip` and `Stasher_X.Y.Z.firefox.zip` are attached to the
new automated GitHub Release here:
[https://github.com/taichikuji/Stasher/releases](https://github.com/taichikuji/Stasher/releases)

The packages contain the same browser manifest. The Firefox archive still
requires Mozilla signing before permanent distribution.
