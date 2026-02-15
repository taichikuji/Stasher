# Triggering a New Release

To build and release a new version of the extension, follow these steps:

### 1. Tag the Release
Create a new version tag. The workflow is configured to detect any tag starting with `v`.
```bash
# Example: Create version 1.2.0
git tag v1.2.0
git push origin v1.2.0
```

### 2. Monitor the Build
Visit the [Actions](https://github.com/taichikuji/Stasher/actions) tab in the repository. The workflow will:
- Parse the version number.
- Package the extension into a `.zip` archive.
- Upload a copy as a workflow artifact.

### 3. Verification
Once complete, the zipped extension will be automatically attached as an asset to a new GitHub Release here:
[https://github.com/taichikuji/Stasher/releases](https://github.com/taichikuji/Stasher/releases)
