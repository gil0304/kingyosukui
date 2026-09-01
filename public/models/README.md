# 3Dアセットの差し替え

このプロジェクトの金魚・ポイ・屋台・水草・石はすべて**手続き生成**です。
外部アセットは一つも必要ありません（会場でファイルが行方不明になる事故が起きない、
という実務上の利点もあります）。

仕様書 §114–§118 のAI生成アセットを使いたい場合は、ここに差し替え用のGLBを置きます。

```
public/models/fish/red.glb
public/models/fish/redwhite.glb
public/models/fish/black.glb
public/models/fish/demekin.glb
public/models/fish/gold.glb
public/models/poi/poi.glb
```

## 差し替えるときの約束

- **向き**: 金魚は **+X が進行方向（鼻先）、+Y が上**。
  `src/game/fish/FishSchool.tsx` がシミュレーション側の +Z前方 との差を吸収します。
- **スケール**: 鼻先から尾の先までを 1.0 として書き出し、
  `FISH_CATALOG[type].size` で実寸へスケールされます。
- **頂点属性**: 遊泳変形のために `aPart` / `aSpine` / `aSide` が必要です
  （意味は `src/game/fish/fishGeometry.ts` の先頭コメント参照）。
  無い場合は変形なしのリジッドな魚になります。
- **形式**: `.glb`。Draco / Meshopt / KTX2 圧縮に対応。
- **ポリゴン数**: 200匹を同時に描くので、LOD0で 1,500 三角形以下を目安に。

置いたファイルは `createFishGeometry` が優先して読み込みます。
無ければ手続き生成のメッシュにフォールバックするので、
一部の魚種だけ差し替えることもできます。
