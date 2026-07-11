# Stasher
A small extension to manage tabs in your Chromium browser!

## Installation

1. Open your browser's extensions page.
2. Enable developer mode.
3. Choose **Load unpacked** and select this directory.

To keep Stasher visible in the browser toolbar, open the browser's extensions
menu and pin Stasher. Toolbar placement is controlled by the browser.

Stasher uses Manifest V3.

## Tag versioning workflow

For the workflow on how to generate and push new releases with tags, read [GUIDE.md](.github/workflows/GUIDE.md)

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

Red : #ef5b5b
Purple: #855bef
yellow: #efde5b
Pink: #ffa8a8

---

Anyways that's it for real now. Thanks as always. If you find bugs or errors report them accordingly.
