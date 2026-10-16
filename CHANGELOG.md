# Changelog

## [0.7.0](https://github.com/fstermann/starlib/compare/v0.6.0...v0.7.0) (2026-10-16)


### Features

* **analyser:** A/B alignment tool with original-BPM correction ([#620](https://github.com/fstermann/starlib/issues/620)) ([d4e1e42](https://github.com/fstermann/starlib/commit/d4e1e4267ee8479ecf3603d4ec7044fe771e0925))
* **analyser:** auto-align tracks to the mix, mix points, SoundCloud BPM and lengths ([#645](https://github.com/fstermann/starlib/issues/645)) ([9b0cc05](https://github.com/fstermann/starlib/commit/9b0cc058b277a6164b5ee3cd800ef27f2e60db5e))
* **breakdown:** Breakdown, with Track Breakdown for local and SoundCloud tracks ([#649](https://github.com/fstermann/starlib/issues/649)) ([bc0bb8f](https://github.com/fstermann/starlib/commit/bc0bb8fba41ad88f492d498c919f338ddd419b49))
* **breakdown:** copy loop audio for Ableton; fix(audio): restart output after wake ([#683](https://github.com/fstermann/starlib/issues/683)) ([30e3c1c](https://github.com/fstermann/starlib/commit/30e3c1c509d80c252084a9102136402e1529aa86))
* **home:** add Breakdown card, default Breakdown to Track view ([#679](https://github.com/fstermann/starlib/issues/679)) ([2bf96b6](https://github.com/fstermann/starlib/commit/2bf96b6b574155b15b6076c9ab0f420dc0ccfb68))
* **library:** add dense 24px row density ([#681](https://github.com/fstermann/starlib/issues/681)) ([0b07928](https://github.com/fstermann/starlib/commit/0b079284ff1f69cf7a5a8601505bef122b605aef))
* **library:** compact rows, resizable row waveform, sortable Rekordbox columns ([#655](https://github.com/fstermann/starlib/issues/655)) ([fb19a45](https://github.com/fstermann/starlib/commit/fb19a45cdf841849f0b9d81fd6ebfb502d2ead56))
* **player:** mix out at last chorus, live transition mixer, background mix fix ([#670](https://github.com/fstermann/starlib/issues/670)) ([64f72b1](https://github.com/fstermann/starlib/commit/64f72b1aa0b9b0642bd6852763a98f7ce3bff1f0))
* **player:** pick the auto-mix start point and skip separator tracks ([#668](https://github.com/fstermann/starlib/issues/668)) ([9d759ca](https://github.com/fstermann/starlib/commit/9d759ca79a78d065b8a11504204ede261bcb642d))
* **player:** smooth EQ bass handover, nearest-downbeat section snap, mixer opens upward ([#682](https://github.com/fstermann/starlib/issues/682)) ([12935e7](https://github.com/fstermann/starlib/commit/12935e75d4e5641938819a2941a7ebb7053772c3))
* **rekordbox:** edit local playlists, Collection view, running notice ([#654](https://github.com/fstermann/starlib/issues/654)) ([b6a8f23](https://github.com/fstermann/starlib/commit/b6a8f23ebb3f08f8c1cf72ec2cde0b876ab33279))
* **rekordbox:** matching tracks panel; fix playlist selection and reorder ([#656](https://github.com/fstermann/starlib/issues/656)) ([206cd0b](https://github.com/fstermann/starlib/commit/206cd0bfdf5ebf585ea7158b9c7507e374ed9cbc))
* **rekordbox:** SoundCloud ids from file tags, export to SoundCloud playlist ([#650](https://github.com/fstermann/starlib/issues/650)) ([e89eca9](https://github.com/fstermann/starlib/commit/e89eca9cdb25a14b38932b40f5fdabe594aaf294))
* Set Analyser with Shazam integration ([#420](https://github.com/fstermann/starlib/issues/420)) ([e9f51cb](https://github.com/fstermann/starlib/commit/e9f51cb4e7d356d2446bff8ed13e5bd1a9bf161f))
* **soundcloud:** add 16 metadata columns to the library table ([#569](https://github.com/fstermann/starlib/issues/569)) ([2ad97b6](https://github.com/fstermann/starlib/commit/2ad97b639d28d47f6e02cb7d42d01241b02d70a4))
* **soundcloud:** drag tracks onto sidebar playlists, refresh playlists ([#646](https://github.com/fstermann/starlib/issues/646)) ([7a95113](https://github.com/fstermann/starlib/commit/7a95113f2c7260db7627ab920f4cd48c4a4f3c28))
* **soundcloud:** playlist picks, SoundCloud BPM for Mixes and picks, key notation setting ([#644](https://github.com/fstermann/starlib/issues/644)) ([f8f9509](https://github.com/fstermann/starlib/commit/f8f9509c516d51d01ecdf14a8db27322f994bc37))
* **soundcloud:** track stations from a track's context menu ([#608](https://github.com/fstermann/starlib/issues/608)) ([a5facd9](https://github.com/fstermann/starlib/commit/a5facd9d1dbb2e7dc5d9cccdd626dc270b641cad))


### Bug Fixes

* **desktop:** stop false "Backend failed to start" popup on cold start ([#680](https://github.com/fstermann/starlib/issues/680)) ([cdf9756](https://github.com/fstermann/starlib/commit/cdf9756dda14a362dc5cefb9802cc33ac44798b0))
* **rekordbox:** mark edited playlists as changed so USB sync exports them ([#684](https://github.com/fstermann/starlib/issues/684)) ([f4f2f59](https://github.com/fstermann/starlib/commit/f4f2f59079fa048ff79e8763836c4415d603ede6))
* **rekordbox:** stream local tracks by id so files outside the music root play ([#678](https://github.com/fstermann/starlib/issues/678)) ([3681bf0](https://github.com/fstermann/starlib/commit/3681bf06dbc7cc6edf1ea949e8955b16ca357546))
* stop silent backend-sidecar failures ([#567](https://github.com/fstermann/starlib/issues/567)) ([563aac9](https://github.com/fstermann/starlib/commit/563aac908316c6fe96f65dcaebfdf3bfdfe8d638))


### Performance

* **backend:** cut redundant work out of scanning, browsing and upstream calls ([#575](https://github.com/fstermann/starlib/issues/575)) ([d16e6e9](https://github.com/fstermann/starlib/commit/d16e6e9d36334616401ed68761856fe131c9e931))


### Refactoring

* **backend:** layer the package into api / services / domain / infra ([#573](https://github.com/fstermann/starlib/issues/573)) ([006ebd5](https://github.com/fstermann/starlib/commit/006ebd5d68b8db06e94bbfcec58614797010e71b))
* **frontend:** collapse the SC BPM reanalyze split button ([#577](https://github.com/fstermann/starlib/issues/577)) ([3023111](https://github.com/fstermann/starlib/commit/302311196affdb1bcf1fe6d4ae14aa5419bcb884))
* move soundcloud_tools into backend, drop dead SC HTTP layer and weekly archiving ([#570](https://github.com/fstermann/starlib/issues/570)) ([90faf45](https://github.com/fstermann/starlib/commit/90faf45b054df01c471333636e2904a471dc8a5e))


### Documentation

* refresh for Rekordbox, player, and AI providers ([#574](https://github.com/fstermann/starlib/issues/574)) ([5510a8d](https://github.com/fstermann/starlib/commit/5510a8d1f64baa80c75abd933ed1bedceb44fdd7))
* refresh screenshots and de-flake the weekly fixture ([#576](https://github.com/fstermann/starlib/issues/576)) ([0e9610f](https://github.com/fstermann/starlib/commit/0e9610fb6c84422c66901554639f8a4cc83a4df0))

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
