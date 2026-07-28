# Stasher
A small browser extension to manage tabs!

## Installation

Stasher supports both Chromium and Firefox. Firefox on a best effort basis, since I do not actively use it, but if reports are done on issues, I will fix them.

- **Chromium:** Open `chrome://extensions`, enable developer mode, choose
  **Load unpacked**, and select this directory.
- **Firefox:** Extract a `.firefox.zip` release, open
  `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and
  select its `manifest.json` until the Mozilla Add-ons listing is available.

Open the browser's extensions menu to pin Stasher to the toolbar. Firefox
temporary add-ons must be loaded again after restarting the browser; permanent
installation requires a signed package. Firefox for Android is not supported
because its tab-group API does not provide the operations Stasher requires.

## Tag versioning workflow

For the workflow on how to generate and push new releases with tags, read [GUIDE.md](.github/workflows/GUIDE.md)

## Testing

Run the zero-dependency test suite with Node.js 20 or newer:

```bash
node --test
```

The tests execute Stasher's background and manager scripts with the supported
browser APIs. Chromium is the primary manual test target. Before releasing,
verify toolbar, keyboard, and context-menu stashing; badge updates; grouped and
loose-tab restoration; title and color preservation; import and export; and
behavior after a browser restart. Firefox is tested on a best-effort basis.

## Description

At this time ( I will update this as it goes ) it does the following:

### Functionality

#### Groupped tabs stashing

Stash tabs via clicking the extension icon. If it finds a tab group being focused at the time of clicking, it will save only the tabs within that tab group.

Then it will remove the tabs and tab group from visibility and move it to internal storage. From there, you can decide to recover it or leave it as-is.

#### Non groupped tab stashing

If you click on a non-group-tab, it will save ALL of the non-groupped-tabs with exceptions. The exceptions are:

* new tab ( empty )
* The manager.html from the extension itself
* Any pinned tabs

Then same thing, it will redirect to the manager, which allows you to recover, delete, or open individual links as needed.

Other features are:

* Dark/Light mode
* Ability to edit the tab groups title and color after it has been stashed
* Completely local and connectivity-agnostic.
* Ability to recover a tab or groupped tab shortly after it has been deleted

That's it for now. As you can see it is minimal, but it is like this by design. Will continue to improve as time passes by.

## Is there a Google Extension Store URL available?

Not at this time. Thinking about having to pay 5$ just to upload it hurts my soul a little bit. If someone donates that amount I will ensure to upload it in due time. Teehee.

If you want to help me with this, I'd really appreciate it, just go ahead and drop a coffee here: [paypal.me](https://paypal.me/ivanperezf). It helps a ton!

## What is the color palette of the project's icon?

* Red : [#ef5b5b](https://www.color-hex.com/color/ef5b5b)
* Purple: [#855bef](https://www.color-hex.com/color/855bef)
* Yellow: [#efde5b](https://www.color-hex.com/color/efde5b)
* Pink: [#ffa8a8](https://www.color-hex.com/color/ffa8a8)

---

Anyways that's it for real now. Thanks as always. If you find bugs or errors report them accordingly.
