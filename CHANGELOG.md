# Changelog

## [0.6.0](https://github.com/fstermann/starlib/compare/v0.5.0...v0.6.0) (2026-07-18)


### Features

* add duration as library field + sortable column ([#377](https://github.com/fstermann/starlib/issues/377)) ([#481](https://github.com/fstermann/starlib/issues/481)) ([13476b0](https://github.com/fstermann/starlib/commit/13476b0eb0020d0ea449b7859e7afe6df34a1622))
* add Rekordbox as a library source ([#211](https://github.com/fstermann/starlib/issues/211), partial) ([#483](https://github.com/fstermann/starlib/issues/483)) ([a3ccc7d](https://github.com/fstermann/starlib/commit/a3ccc7d0226b549b5c1e527f66033ffa1e965174))
* **bpm:** accuracy fixture + harness + opt-in DP beat tracker ([#466](https://github.com/fstermann/starlib/issues/466)) ([a83b8cc](https://github.com/fstermann/starlib/commit/a83b8cc3d9c3f0b7fa9ca7d4847672b26b2d142e))
* **bpm:** stronger (DP) mode + sync table edits to pitcher ([#477](https://github.com/fstermann/starlib/issues/477)) ([77ebe27](https://github.com/fstermann/starlib/commit/77ebe27ede73b549c52fcb328295b659bc0b3c90))
* **library:** reanalyze + manual BPM edit ([#465](https://github.com/fstermann/starlib/issues/465)) ([eaf2359](https://github.com/fstermann/starlib/commit/eaf23597234d7c277d2388cfc0c96931d361e0c3))
* **library:** show empty folders in tree view ([#530](https://github.com/fstermann/starlib/issues/530)) ([adca6d9](https://github.com/fstermann/starlib/commit/adca6d982e7a0b338c27d5acfbd5f2e767bf5f51))
* **library:** tree counts reflect active filters ([#399](https://github.com/fstermann/starlib/issues/399)) ([#529](https://github.com/fstermann/starlib/issues/529)) ([6f5ee10](https://github.com/fstermann/starlib/commit/6f5ee10d85266abc610fc2712705defad0c5ae27))
* **nav:** browser-style back/forward arrows ([#527](https://github.com/fstermann/starlib/issues/527)) ([6d871d9](https://github.com/fstermann/starlib/commit/6d871d90f7159cad54141c6f61b89aafced853d8))
* **palette:** queue actions in track search context menu ([#550](https://github.com/fstermann/starlib/issues/550)) ([4237cb9](https://github.com/fstermann/starlib/commit/4237cb9167b56ce79da543100d1bddd9b071524f))
* **player:** auto-mix crossfade between tracks ([#532](https://github.com/fstermann/starlib/issues/532)) ([1b12307](https://github.com/fstermann/starlib/commit/1b12307141c75cda4dd3df3a24554a21d539aea0))
* **player:** queue preview panel with add-to-queue ([#546](https://github.com/fstermann/starlib/issues/546)) ([9c7f4fe](https://github.com/fstermann/starlib/commit/9c7f4fea1d4d1d256329fb689e646c451d585e0a))
* **player:** rekordbox-style zoomable waveform with grid, sections, cues ([#531](https://github.com/fstermann/starlib/issues/531)) ([49c8eb7](https://github.com/fstermann/starlib/commit/49c8eb7f86960dd5322bd53a706760037a0ffae6))
* **player:** streamline now-playing indicator across all three views ([#543](https://github.com/fstermann/starlib/issues/543)) ([61e4185](https://github.com/fstermann/starlib/commit/61e41850518cccc35bb71d05f7c5aea4672f0385))
* **rekordbox:** read & play from USB exports ([#523](https://github.com/fstermann/starlib/issues/523)) ([67eabb5](https://github.com/fstermann/starlib/commit/67eabb560880adb1b14b9de3e52b8dec9dd48d9c))
* shared TrackTable + Rekordbox artwork, waveforms & playback ([#488](https://github.com/fstermann/starlib/issues/488)) ([fc677ed](https://github.com/fstermann/starlib/commit/fc677ede3a8eee1c50db06acb8f8ea6a82767e49))
* **soundcloud:** BPM range filter ([#549](https://github.com/fstermann/starlib/issues/549)) ([66e451c](https://github.com/fstermann/starlib/commit/66e451ced4205d39febb2048e7d64493d57d6d8e))
* **soundcloud:** group per-row link icons into download + search menus ([#544](https://github.com/fstermann/starlib/issues/544)) ([1226a86](https://github.com/fstermann/starlib/commit/1226a86659a21e217976607fa4f6d76ee0a4ca4c))
* **soundcloud:** New Today / New This Week smart lists ([#548](https://github.com/fstermann/starlib/issues/548)) ([ec63786](https://github.com/fstermann/starlib/commit/ec6378698b5272f597a72b8a883528c58864447b))
* **soundcloud:** playlist management from track rows and sidebar ([#547](https://github.com/fstermann/starlib/issues/547)) ([000a401](https://github.com/fstermann/starlib/commit/000a4016f83ecffa6d1ed58117b9e6e5e8c37d4a))


### Bug Fixes

* **library:** don't block Apply Rules when toggling the SoundCloud chip ([#552](https://github.com/fstermann/starlib/issues/552)) ([a7df036](https://github.com/fstermann/starlib/commit/a7df0363461b047abd2f5ea0f431deb913fd56b8))
* **library:** stop Fetch from Downloads dialog overflowing on narrow windows ([#551](https://github.com/fstermann/starlib/issues/551)) ([c585a74](https://github.com/fstermann/starlib/commit/c585a74fea4e15c49a1cb8413ca296203d5495c2))
* **player:** drop filtered-out tracks from SoundCloud autoplay queue ([#545](https://github.com/fstermann/starlib/issues/545)) ([964ab3b](https://github.com/fstermann/starlib/commit/964ab3ba298b64d1da098f2f03135f899351094d))
* **rekordbox:** USB player waveform + waveform-style setting ([#524](https://github.com/fstermann/starlib/issues/524)) ([fb75589](https://github.com/fstermann/starlib/commit/fb75589982ac11b2fe947881d8ea4d6b92d914d2))
* **settings:** stop UI store and backend sharing settings.json ([#515](https://github.com/fstermann/starlib/issues/515)) ([#526](https://github.com/fstermann/starlib/issues/526)) ([59719c4](https://github.com/fstermann/starlib/commit/59719c4cb9dfb4b58c647d5490a66f7f6aeec53b))


### Refactoring

* rework auto completion ([#422](https://github.com/fstermann/starlib/issues/422)) ([e1333ba](https://github.com/fstermann/starlib/commit/e1333baf38c5bd08e6d83d01ab17f46ca8efd712))
