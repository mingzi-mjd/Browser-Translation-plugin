# Reference and attribution

This basic extension references KISS Translator's provider request protocols. UI, DOM grouping, bilingual rendering, input preview/replacement, queue and packaging are independently implemented.

- Project: https://github.com/fishjar/kiss-translator
- Author: fishjar / Gabe and contributors
- License: GPL-3.0
- Inspected commit: 025064771b26cd1383655320e2b944019e9461d6
- Google adapter: https://github.com/fishjar/kiss-translator/blob/025064771b26cd1383655320e2b944019e9461d6/src/builtin-plugins/google.js
- Microsoft adapter: https://github.com/fishjar/kiss-translator/blob/025064771b26cd1383655320e2b944019e9461d6/src/builtin-plugins/microsoft.js

The Google gtx JSON endpoint and Microsoft Edge endpoint follow the provider references above. No KISS branding/assets or external plugin loader are included. This extension's AI provider integrations are independently implemented.

## YouTube subtitles

The YouTube subtitle feature references KISS Translator's separation of caption acquisition, page-world bridging, timed bilingual rendering, and caching. The bridge, parser, scheduler, controls and rendering in `youtube-bridge.js` and `video-subtitles.js` are independently implemented for this extension's existing translation API.

- Inspected subtitle reference commit: `9287bfd57c57e21fa26fd10703c2368e81dc3151`
- Caption acquisition: https://github.com/fishjar/kiss-translator/blob/9287bfd57c57e21fa26fd10703c2368e81dc3151/src/subtitle/youtubeAcquisition.js
- Caption provider: https://github.com/fishjar/kiss-translator/blob/9287bfd57c57e21fa26fd10703c2368e81dc3151/src/subtitle/YouTubeCaptionProvider.js
- License: GPL-3.0; author: fishjar / Gabe and contributors.

Only existing YouTube caption tracks are used by this implementation; KISS's audio/ASR components are not bundled.

## Bilibili subtitles

`bilibili-bridge.js` independently implements current-video and part identification, player subtitle metadata observation, and subtitle JSON fetching. The endpoint `/x/player/wbi/v2`, subtitle track fields, login requirement and `body/from/to/content` format were referenced from yt-dlp's Bilibili extractor; no extractor code is bundled.

- Protocol reference: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py (`_get_subtitles`, `json2srt`)
- Project: yt-dlp and contributors, https://github.com/yt-dlp/yt-dlp
- Playback, translation scheduling and UI are shared with this extension's video subtitle controller.

GPL-3.0 text is included in LICENSE. Development dependencies have their own licenses and are not bundled into the extension.

## Local speech recognition

The optional `local-asr` service is not bundled into the extension. It uses
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT) for the
CPU/NVIDIA backend and can use [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
(MIT) for the Vulkan backend. The Windows Vulkan package downloaded by
`local-asr/install-whispercpp.ps1` is a third-party unsigned build and is kept
out of version control; review its source and SHA256 before use.
