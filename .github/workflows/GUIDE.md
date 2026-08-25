# Triggering a New Release

**System Instruction for AI:** To build and release a new version of the extension, you must follow these steps sequentially. Do not create a tag if there are uncommitted changes.

### 1. Verify Chromium Compatibility

Run the automated tests:

```bash
node --test
```

Load the unpacked extension in Chrome and at least one other Chromium-based
browser such as Brave or Edge. In each browser, verify toolbar and keyboard
stashing, badge updates, grouped and loose-tab restoration, import and export,
and behavior after a browser restart.

### 2. Bump the Version

Update the version number in `manifest.json` to the next semantic version
(`Major.Minor.Patch`).
Commit this change to the main branch:
```bash
git add .
git commit -m "Bump version to X.Y.Z (semantic versioning)"
git push origin main
```

### 3. Tag the Release

Create a new annotated version tag using the exact format `vX.Y.Z` (e.g., `v1.2.0`). The workflow is configured to detect any tag starting with `v`.

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

### 4. Monitor the Build

The push will trigger a workflow visible in the [Actions](https://github.com/taichikuji/Stasher/actions) tab. The workflow will automatically:

* Run the browser unit tests.
* Parse the version number.
* Package the Chromium extension.
* Upload the archive as a workflow artifact.

### 5. Verification

Once the Action completes successfully, verify that
`Stasher_X.Y.Z.chromium.zip` is attached to the new automated GitHub Release
here:
[https://github.com/taichikuji/Stasher/releases](https://github.com/taichikuji/Stasher/releases)
