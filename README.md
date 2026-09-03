<p align="center">
  <img src="assets/icon_color.svg" alt="Stasher mascot" width="128">
</p>

<h1 align="center">Stasher</h1>

<p align="center">
  Yet Another Tab Manager by <a href="https://github.com/taichikuji">@taichikuji</a>
</p>

<p align="center">
  A small, opinionated browser extension for putting tabs away and finding your way back to them.
</p>

Stasher is for the tabs you are not ready to close, but do not need in front of you
right now. Save them locally, give a stash a memorable name, and restore it when
you are ready.

It is intentionally modest. Stasher is not trying to be an always-open tab
workspace, a cloud service, or a dashboard full of things to configure. It is a
quiet place to put tabs away.

## What it does

- Stash a focused tab group from the extension button.
- Stash the selected tabs from Chromium's tab strip.
- Stash one web tab from its **Stash this tab** context-menu action.
- Keep grouped and loose tabs together in the manager.
- Rename a stash and change its tab-group color after saving it.
- Search stash titles, tab titles, and URLs.
- Restore a whole stash or open individual tabs from it.
- Import and export Stasher JSON backups.
- Work completely locally, without an account or network connection.
- Use light or dark mode.

Pinned tabs that are explicitly stashed are pinned again when restored. Ordinary
unstashed pinned tabs are left alone when Stasher saves loose tabs, so the tab
strip keeps its usual shape.

## What it does not do

- It is not an always-on sidebar or a live replacement for the browser's tab strip.
- It does not search from the address bar; the manager is the home for saved stashes.
- It does not require an account, cloud sync, or a network connection.
- It does not continuously track, auto-close, or reorganize tabs in the background.
- It does not ask you to maintain a complicated system of folders, tags, stars, or notes.

Those boundaries are intentional. Stasher helps you put tabs away and bring them
back; it does not try to manage every moment of your browsing.

## Installation

Stasher supports Chromium-based desktop browsers, including Google Chrome,
Brave, Microsoft Edge, Opera, Vivaldi, and compatible Chromium forks.

1. Open your browser's extensions page (`chrome://extensions`,
   `brave://extensions`, or `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Open the extensions menu and pin Stasher to the toolbar.

## A small note about Firefox

Stasher was created for Chromium-based browsers and has not been fully tested
on Firefox. Firefox support has also not been requested, so maintaining a build
that cannot be confidently validated is outside the project's current scope.

## Development

The project has no runtime dependencies. Run the test suite with Node.js 20 or
newer:

```bash
node --test
```

Before releasing, test the extension in Chrome and at least one other Chromium
browser such as Brave or Edge. The release workflow is documented in
[GUIDE.md](.github/workflows/GUIDE.md).

## Contributing

Stasher is opinionated, but not closed to sensible improvements. If something
feels useful and keeps the project healthy, open an issue or pull request and
explain the problem it solves.

## Support

Stasher is not currently published in the Chrome Web Store. If you would like
to help with that someday, you can [buy me a coffee via PayPal](https://paypal.me/ivanperezf).

## Icon palette

- Red: [#ef5b5b](https://www.color-hex.com/color/ef5b5b)
- Purple: [#855bef](https://www.color-hex.com/color/855bef)
- Yellow: [#efde5b](https://www.color-hex.com/color/efde5b)
- Pink: [#ffa8a8](https://www.color-hex.com/color/ffa8a8)

Found a bug or have an idea? Please report it with enough context to reproduce
the behavior. Thanks for taking the time to use Stasher.
