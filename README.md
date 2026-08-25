# Stasher
A small browser extension to manage tabs!

## Installation

Stasher supports Chromium-based desktop browsers, including Google Chrome,
Brave, Microsoft Edge, Opera, Vivaldi, and compatible Chromium forks.

Open your browser's extensions page (for example, `chrome://extensions`,
`brave://extensions`, or `edge://extensions`), enable developer mode, choose
**Load unpacked**, and select this directory.

Open the browser's extensions menu to pin Stasher to the toolbar.

## Why is there no Firefox build?

Stasher was created for Chromium-based browsers and has never been fully tested
on Firefox. It has also not been actively used there, nor has Firefox support
been requested. Maintaining a build that cannot be confidently validated is
therefore outside Stasher's scope.

## Tag versioning workflow

For the workflow on how to generate and push new releases with tags, read [GUIDE.md](.github/workflows/GUIDE.md)

## Testing

Run the zero-dependency test suite with Node.js 20 or newer:

```bash
node --test
```

The tests execute Stasher's background and manager scripts against Chromium's
standard `chrome.*` extension API namespace; despite its name, that namespace
is shared by compatible Chromium-based browsers. Before releasing, test Chrome
and at least one other Chromium-based browser such as Brave or Edge. Verify
toolbar and keyboard stashing; badge updates; grouped and loose-tab restoration;
title and color preservation; import and export; and behavior after restarting
each browser.

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
