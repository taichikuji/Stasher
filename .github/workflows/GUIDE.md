# How to trigger the Release Workflow

To trigger the `release.yml` workflow and generate a new extension package, follow these steps:

1. **Commit the workflow** (if not already done):
   ```bash
   git add .github/workflows/release.yml
   git commit -m "Add release workflow"
   git push
   ```

2. **Create a new version tag**:
   The workflow triggers on tags starting with `v` (e.g., `v1.0.0`).
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. **Verify the release**:
   Go to your repository on GitHub under the **"Releases"** section. You should see a new release with the version name containing the `Stasher_1.0.0.chromium.zip` file.
