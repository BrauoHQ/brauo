# Brauo Privacy Policy

Effective date: 2026-07-13

## What Brauo does

Brauo is a Chrome extension that reads user-selected blocks of text aloud using Brauo Cloud.

## What data is processed and when

Brauo sends only the text of blocks the user chooses to read and the selected voice ID to the Brauo API at `api.brauo.com` so Brauo Cloud can generate audio.
Nothing is sent until the user starts reading or plays a voice preview; a preview sends only a fixed sample sentence, never page content.
Page URLs are not sent.
The API also receives the user's Brauo API key to authenticate the request.
Each request carries a fixed label naming the extension, so Brauo can tell how much its own apps are used; the label is the same constant for every user and every page, and identifies the software rather than the person.

## Where your text goes

The selected text and voice ID are sent only to Brauo Cloud at `api.brauo.com` to generate and return audio for the read-aloud feature.
Brauo Cloud may cache generated audio using a one-way fingerprint of the text and selected voice so repeated reads are faster.

## API key and settings

The Brauo API key is stored only on the device in `chrome.storage.local`.
The key is sent only to `api.brauo.com` to authenticate requests.
Extension settings, such as the selected voice and playback speed, are stored in `chrome.storage.sync`.
Uninstalling the extension removes locally stored extension data from the browser; synced settings remain subject to the browser's sync behavior.

## What Brauo does not do

The extension collects no analytics.
The extension performs no tracking.
The extension collects no browsing history.
The extension displays no ads.
Brauo does not sell user data or anything else derived from it.

## Data retention

The extension itself does not retain the text sent for reading.
It stores the API key and extension settings only in the browser as described above.
Brauo Cloud may retain cached generated audio keyed by a one-way fingerprint of the text and voice to make repeated reads faster.
Brauo Cloud does not receive page URLs.

## Limited Use

User data is used solely to provide the read-aloud purpose requested by the user.
User data is never sold.
User data is never used for advertising.
User data is never used to determine creditworthiness or for lending purposes.
Brauo's use and transfer of user data are consistent with the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Changes to this policy

This policy may be updated if Brauo's data practices or legal obligations change.
The effective date at the top will be updated when changes are made.

## Contact

For privacy questions, email hola@andreslee.com.
