# 音について

効果音・環境音はすべて **Web Audio API で合成**しています（`src/audio/`）。
音声ファイルは一つも必要ありません。

- `sfx.ts` — 水音、しぶき、ポイが破れる音、捕獲音などをノイズとフィルタから合成
- `ambience.ts` — 水のざわめき、遠くの雑踏、まばらな祭囃子（D minor ペンタトニック）

差し替えたい場合はここに音源を置き、`src/audio/sfx.ts` の `renderSfx` を
`AudioContext.decodeAudioData` に切り替えてください。
仕様書 §111 のとおり、**ゲームセンター的なBGMを主役にしない**こと。
