# 干员皮肤 (Operator skins)

Local installation metadata (`tools/local-extract/skin-meta.mjs`) applies the same validated character role fixes as
default models. Every overridden skill checks its clip names against that outfit's skeleton; missing clips are
reported and retain the resolved outfit role. Utage's 伪装 / 夏卉 FA661 keep S1's rest and S2's ordinary attacks.
Ifrit's 轻松旅途 also retains ordinary attacks for S1/S3: its official skin `_animations` table does not bind the
skeleton's extra `Skill` / `Skill_Down` clips. Its numbered skill family and all other outfits are preserved.
Regenerate `data/local-skins.json` after updating the extractor; this installation sidecar and art stay outside Git.

An operator's Spine model and its pictures can be replaced by one of its official alternative outfits (时装). This
document is the normative reference for that feature; the art itself is **never** downloaded or written by the server —
it comes from a **cosmetic plugin's overlay** (docs/PLUGINS.md §9), which the server's owner installs in `plugins/` and
each player switches on for themself.

> 上游 #652 被关闭的原因写在这里，因为它是这个设计的出发点：**服务器不提供安装通道**。当时的 `room.skin.install`
> 让任何已连接的客户端都能让服务器去网上下载文件并改写所有客户端共读的 `data/assets.json`，而随包发布的
> `data/skins-installed.json` 又会让更新校验对不上。本实现没有安装报文、不写 `data/` 下的任何文件、不随包发布任何
> 安装状态：皮肤属于插件，插件怎么落地是 `plugins/` 目录（安装、studio、ZIP）本来就有的问题。

## The data: one overlay, no catalogue file

```
plugins/<id>/plugin.json
  └── assets (or a .json file):  chars[<charId>].illust ……     the operator's own 立绘 (one picture)
                                 chars[<charId>].skins[<skinKey>] = { name, group, avatar, avatarE2,
                                                                      portrait, portraitE2, illust,
                                                                      spine: { front, back? },
                                                                      tokens: { <tokenId>: { tokenSkinId?, spine } },
                                                                      voice: { <slot>: file | [file…] },
                                                                      voiceJp?, voiceEn?, voiceKr?, voiceNative? }
        │
        ├── the server checks the overlay (shared/plugins/visual.js, docs/PLUGINS.md §9) and serves it as a document:
        │   /vs/<vs16>/overlay.json — composed on the INSTALLATION's manifest, never on a copy of it
        │
        └── the browser composes it (public/js/cosmetics.js cosmetics.apply) on the manifest it already loaded
                 │
                 └── data.get('assets') — what every screen reads (public/js/data.js setView)
                          │
                          ├── chars[<charId>].skins[<skinKey>]  →  the picker's rows (public/js/ui/skins.js availableSkins)
                          ├── chars[<charId>].skins[<skinKey>].spine  →  the model (public/js/assets.js spineEntry { skin })
                          └── chars[<charId>].skins[<skinKey>].tokens[<tokenId>].spine  →  a summon's model
                              (assets.js tokenSkinSpine, found from the skin its summoner wears)
```

Three properties are load-bearing:

- **A skin key is the KEY, and it is data.** It carries `@` `#` `+` `.` (`char_002_amiya@winter#1`), so it is **not** an
  `isId` (shared/protocol.js `isSkinId`). A plugin that has no official id for a skin may write the stem form
  (`char_102_texas_epoque_7`) [ASSUMED: docs/PLUGINS.md §9]. Whatever writes a skin and whatever wears it must agree on
  that exact string.
- **The choice is keyed by OPERATOR (charId), not by chess.** `chars[<charId>].skins` is the manifest's own grouping, so
  one entry covers an operator's normal piece, its elite (the merge) and a 自选 slot fielding it. The renderer agrees:
  a unit's skin resolves through `d.spine ?? d.charId ?? u.defId` (server/sim/snapshot.js), i.e. the charId.
  Every owner/scout board, hand, temp and battle input resolves the **effective body** with `PlayerState.fieldRecord`:
  a stand-in uses `backup.charId`, a 自选 slot its pick. Official source:
  `activity_table.activity.AUTOCHESS_SEASON.act2autochess.charShopChessDatas` `backupCharId` (for example
  `chess_char_3_01_a`: `char_103_angel` → `char_603_csnipe`). [ASSUMED] Skin choices follow that body too, so an original
  operator's selected outfit never dresses its stand-in; the official table specifies bodies, not this cosmetic UI.
- **A missing piece falls back; nothing is ever a placeholder.** `spineEntry(m, id, { skin })` draws the operator's own
  model when the skin (or its model) is not in the manifest; `avatarUrl` / `portraitUrl` / `illustUrl` fall back to the
  operator's own pictures. The picker shows the operator's portrait on a skin that ships none.

## Picture-only outfits (0.3.2, B6)

The maintainer's 2026-10-18 **option A** makes a `skins` record with pictures but no Spine wearable.
The picker labels it 「仅更换头像与立绘」. Its owner's avatars and portraits change, including loadout / DIY,
shop / reward cards, detail panels, bond members, thumbnails, settlement / result rows, combat metrics and the DOM fallback field.
Battle Spine keeps the effective operator's default Front / Back. Missing image fields independently use the
operator's existing normal / elite fallbacks; removing the plugin restores defaults without erasing the saved choice.
Model outfits retain their model resolution and picture fallbacks. A replacement directly on `chars[charId]`
without a `skins` entry still does not enable the picker.

Source: the official [skin_table.json](https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/skin_table.json)
`charSkins` associates `skinId`, `charId`, `avatarId`, `portraitId`, `illustId` and `battleSkin` separately.
That table does not prescribe missing-plugin behavior; wearability and the note above are the maintainer's decision.
[ASSUMED] Any of `avatar`, `avatarE2`, `portrait`, `portraitE2`, `illust` counts as a picture; metadata alone does not.
An unfinished Spine map without Front uses both default views.
An E2-only picture is offered in the picker but only replaces elite art during play; the normal image falls back.
The existing portrait → illustration preference is retained; an illustration never substitutes for an in-game avatar.

[ASSUMED] Card images follow the same latest-public-choice rule as the renderer, including clears and the
「显示其他玩家的皮肤」 switch. A local picker reads the browser's choice; an explicit owner reads that seat's public
map, or its unit's skin when the seat is unavailable, never the viewer's map. Unowned catalogue/statistics art stays
unowned. `OperatorImage` subscribes to choices, visibility and the composed manifest, so open cards refresh on changes.
Effective stand-in / DIY bodies are resolved before that lookup, preserving §34.23 and #686.

## 召唤物换装 (summon skins)

An outfit may also restyle the summons its operator's skills place (a 律动方格, a shield, a trap): the skin's
`tokens` map names, per token id, the model that summon wears while its summoner wears that skin.

- **The mapping lives under the OPERATOR; the id arrives with the summon.** `room.skins` and `UnitInfo.skin` carry the
  skin id, while `chars[<charId>].skins[<skinId>].tokens[<tokenId>]` is where the model is written. `public/js/assets.js`
  `tokenSkinSpine(m, tokenId, skinId)` resolves the operator through a `skinId → charId` map built once per composed
  manifest (a plugin may reuse one key under two operators, so every candidate is tried in order), and `spineEntry`
  asks it first for a token id. Without a mapping the summon draws the model it always drew (its local-client one, else
  the web one), so an outfit that restyles nothing keeps today's behavior exactly.
- **There is deliberately no `owner` field.** The manifest groups skins by operator already, so the summoner's own
  record answers the question; the install-channel design needed `tokens[].owner` because it wrote its own manifest
  (`data/assets.json`), and in practice most of a committed manifest's tokens have none. Our overlay can therefore not
  have one, and a plugin never writes one.
- **One model per token, and `spine` is REQUIRED.** A summon has no Front / Back pair: the record is
  `{ tokenSkinId?, spine }`, where `spine` is the same single-model kind `tokens[<tokenId>].spine` is (skel / atlas /
  textures / anims). A mapping without one is refused by the overlay schema (`shared/plugins/visual.js`
  `TOKEN_SKIN_RECORD`, `schemas/overlay.schema.json` `$defs.tokenSkinRecord`) because it would change nothing — and the
  pair form (`{ front, back? }`, correct for a skin itself) is refused too, which is the one mistake this shape invites.
  At most 64 mappings per skin; the token id is the key the installation's `tokens` container holds.
- **The sim only carries the id.** `server/sim/battle/players.js` inherits it: `_makeAlly` takes the summoner's `skin`
  when it creates a token, and the late link (a board token listed before its owner, board order being top→bottom)
  fills it in once the owner exists. Nothing in `server/sim/` reads it beyond carrying it, `snapshot.unitInfo.skin`
  stays `undefined` without one (so the wire is byte-identical), and `test/golden/*.json` does not move.
- **When it takes effect.** The choice is published the moment it is made, but a summon's model is taken from the unit
  it inherits, which is built with the battle input: summons placed in the battle running when the choice changed keep
  the old look, and **the next battle uses the new one**. That differs from operators, whose on-screen appearance the
  public selection refreshes immediately (`render/app.js` `setSkins`) — an operator has an owner seat and a public map
  to read, a summon has neither.
- **What does not follow.** A **prep** board's token piece (the hand, the 临时整备区, a scouted bench) keeps its own
  model: those views resolve an operator's skin and a token piece has no operator, so it changes when it deploys. A
  summon's **avatar** is not restyled either (`tokenAvatarUrl` takes no skin) — only its model is.
  设置「显示其他玩家的皮肤」 off hides another seat's summons along with its pieces, which falls out of the same switch.

## 皮肤语音 (outfit voices)

An outfit may carry its own lines: `skins[<key>].voice` (the Chinese tree) plus optional `voiceJp`, `voiceEn`,
`voiceKr`, `voiceNative` — each a map from a slot name to one audio file or a list of 1–16, the same shape and the same
slot names as the operator's own `audio.voice[<charId>]` (docs/PLUGINS.md §9).

- **Which line plays.** The outfit's line in the language this player picked (设置 → 语音语言, `voiceLangFor`) first, then
  the operator's dub, then the outfit's Chinese line, then the operator's own. A slot the outfit does not voice falls back
  to the operator's, never to silence — and an operator with no voice bank of its own still speaks its outfit's line.
- **A Chinese-only outfit does not outrank a dub the operator has.** With 中文 picked the outfit's line plays; with
  日本語 picked and a Japanese dub installed, the operator's Japanese line plays even where the outfit ships Chinese for
  that slot. The setting is about the language a player hears, and the operator's own trees already behave this way — an
  outfit that wants to be heard in a foreign language ships that tree. That is what the five trees are for.
- **Fallback inside a language is unchanged.** A picked line whose file will not load plays the same-named line of the
  outfit's Chinese tree, else the operator's same-named Chinese line, else a drawn operator line — the existing
  `_playVoice` contract (`public/js/audio.js`), identical to an installation with no outfit at all.
- **Where it plays.** Battle lines (行动出发 / 行动开始 / 部署 / 作战中N) read the unit's own `UnitInfo.skin` (`_track`
  keeps it; the three call sites pass it), the 选中 line the appearance the panel resolved, and the settlement line this
  browser's own choice for the operator who speaks. Nothing else moves: no message, no wire field, no new setting. The
  试听 dropdown still plays the operator's own trees (an outfit has no picker surface of its own).
- **The outfit is found through the manifest, by skin id** (`skinRecordOf`: under the voice's own operator first, else one
  scan of `chars[].skins`), because a stand-in's voice body and the outfit's operator can differ. It lives in `audio.js`
  rather than reusing `assets.js`'s map because `main.js` loads this module and
  `test/ui/plugins-client.test.js` pins that the asset store stays off the boot path.
- **The schema and this runtime ship in one commit.** `shared/plugins/visual.js` (the five trees on a skin record),
  `schemas/overlay.schema.json` (`$ref` to the operator tree's own definition) and the fixture change together: a field
  the schema refuses would be dropped by the runtime with a warning, and a field the runtime does not know would be
  silently ignored — the two halves of the upstream 语音槽 pull request that never merged.

## 小人预览 (model preview)

The picker's enlarged view plays the row's **real skeleton**: it opens on 待机 and offers a button per animation the
model ships, so an outfit can be judged the way a board shows it.

- **Live, not a picture.** The frames come from the same `assets.spine.acquire` path a battle unit uses, so what the
  frame shows is what a deploy shows, at no extra bytes — the model files are already in the HTTP cache after a battle.
  A pre-rendered clip would be one new file per skin: a 256 px GIF of a single clip measured ≈ 360 KB (≈ 190 MB over a
  catalogue) at a worse frame rate.
- **The buttons follow the model, not a list** (`clipsOf`): the entry's own `anims` roles give 部署 / 待机 / 攻击 / 技能,
  and **every remaining clip** of its `animations` gets a button labelled with the clip's own name, so nothing a skeleton
  ships is unreachable. Three or more extras fold behind 更多动画; two or fewer stay inline, where the toggle would be
  taller than the buttons it hides.
- **One canvas, owned by the box.** The preview mounts its own canvas and destroys it on unmount, so a model that
  finishes loading after the modal closed can never attach itself to a node that is gone. The box keeps a constant vdom
  shape (an art layer plus a mount layer) so a re-render cannot diff the canvas away, and the model is measured
  **after** its first update: `getLocalBounds()` on a freshly built skeleton returns 0×0 and the manifest's union bounds
  (≈1200 px for a 300 px idle pose) would shrink it to a speck.
- **A row with no model** — a picture-only outfit — keeps the enlarged 立绘 it always had, and a model that cannot load
  keeps the static art with the caption 模型不可用, so the picker is never blocked by a broken file or a machine without
  WebGL.
- **PIXI and the asset store load lazily**, inside the effect: `ui/skinPicker.js` is reachable from
  `screens/loadout.js`, and `test/ui/plugins-client.test.js` pins that `public/js/assets.js` stays off the boot graph.
- **What this first version does not do**: a button plays its group's first clip (an attack plays its loop rather than
  the Begin → Loop → End sequence), the 试听 dropdown still plays the operator's own trees, and there is no token model
  preview — the frame is the piece the row belongs to.

## 官方时装特效 (official skin effects)

Some outfits change the operator's **effects**, not only the model: the client attaches a `CharacterSkinHooker` to every
outfit prefab whose `_replaceEffectPairs` says "when this unit plays `from`, play `to` instead" — attack hits, trails,
skill buffs, even the shared birth effect (`common_char_birth_01` → `kalts_birth_01_boc#6`). On the 2026-10 build that is
**443 outfits, 6590 pairs**; the pairs are per operator outfit, so wearing `char_003_kalts@boc#6` changes Kal'tsit's
hit / start / trail / skill-buff / birth effects and nothing else's.

This one **cannot** come from a cosmetic plugin: the variants are official effect prefabs (particles, textures, meshes),
which a plugin cannot legally or practically carry. It is therefore an extraction feature — off unless the owner
extracts it — with the plugin-free fallback being what the game always did (the base effect).

### The data (`index.json` → `skinFx`)

`tools/local-extract/skinfx.py` reads the client's `skinpack/<charId>.ab` bundles, finds each hooker, names the outfit
from the GameObject it hangs under (`<charId>_<stem>` → `<charId>@<stem>`, the official id) and writes:

```json
"skinFx": {
  "char_003_kalts@boc#6": {
    "replace": { "kalts_attack_01_hit": "kalts_attack_01_hit_boc#6", "common_char_birth_01": "kalts_birth_01_boc#6" },
    "fakeProjectiles": [{ "originalProjectileKey": "projectile_chr_kalts", "graphicProjectileKey": "…_graphic",
                          "logicProjectileKey": "…_logic", "muzzlePoint": 5 }]
  }
}
```

- It is an **optional section**: an index without it, or an outfit without an entry, plays the base effects, so older
  extractions stay readable and the index's `version` does not move for it.
- The replacement keys are **new** effect prefabs. `skinfx.py` prints them (and `--keys-out` saves them) for a
  follow-up run that exports those prefabs into the same set:
  `.venv/bin/python tools/local-extract/extract.py --only fx --fx-keys $(paste -sd, /tmp/k.txt)`. Without that step the
  variants are missing and the runtime falls back — the traps both upstream attempts hit (「皮肤特效没有、原版也没有」).

### The runtime (`render/vfx/wiring.js`)

- `outfitOf(view)` is the outfit the view wears (`info.skin` — the id the cards, the portrait and the voice use). It is
  **not** `skinOf`, which is the Spine model's own skin name used for mount points.
- `playOn` maps the key through the outfit's `replace` before it plays anything; the ATTACKER's outfit decides effects
  an attack puts on someone else (`o.skinFrom`, projectiles' hit rows), the view's own otherwise. A replacement the set
  does not hold keeps the base key — never a silent drop.
- `keysFor` preloads the variants of the outfits in the battle, so the first cast does not wait on a fetch.
- Body mounts and attached effects use the displayed model's tile conversion (`UnitView.effectScale`): the field's
  `UNIT.modelScale = 1/320` divided by the extracted standard `0.27 × 0.01` (Graphic × SkeletonDataAsset), about
  1.1574. Static points take that factor; live Spine bones already include it and are never scaled twice. FOOT /
  HIT / HEAD / MUZZLE / Special effects use it uniformly, including child meshes and Local / Shape particles.
  Ground / tile effects, map-position effects and projectile flight distances keep their world-tile dimensions.
  Late-loaded descriptors and chained effects select their own placement; pooled instances reset the factor.
  This conversion is shared by default models and outfits, and needs no asset re-extraction.
- Body effects also preserve child depth: an order-0 renderer authored behind the skeleton (including nested
  helpers, 魔王 S3's background) draws under it; positive sorting orders retain foreground placement. Depth is
  measured along the effect root's Z axis so the Graphic tilt is not mistaken for a background offset.
- 魔王 S3 includes the mode AuraHeal's owner / range loops and carrier effects, with the caster's outfit deciding
  the carrier variant. New indexes export `modes[].attack.buffUses`; a transcribed fallback supports existing indexes.
  The official redistribution burst follows the sim's existing `redistribute` event. Carrier loops follow the
  equipped skill's grid and end on leaving it, skill end or source / target removal; overlapping identical variants
  share one loop. **[ASSUMED]** Carrier visibility uses living allies in that grid; snapshots do not expose `noHeal`
  buffs. This affects decoration only. Owner / range wiring uses existing files. An old set missing the default
  `cetsyr_skill_03_burst_01` retains its procedural pulse until that prefab is extracted / installed; an installed
  outfit variant can play independently. No combat or protocol changes. Targeted extraction preserves `skinFx`.
- `fakeProjectiles` are extracted but **not wired yet** (the client's projectile-graphic replacement); an outfit that
  needs one plays its normal projectile.

### Limits

- The extraction is a machine-local feature: `public/assets/` is not in git, and a player without the extracted set
  simply sees the base effects. Nothing about the skin choice, the sync, the sim, the golden results or the protocol
  changes.
- Every outfit the client marks is extracted, including ones this build never offers (an outfit record the catalogue
  does not hold is unreachable by design).
- Volume, measured on 4 outfits (Kal'tsit's two, Amiya's `test#1`, Swire the Elegant Wit's
  `ambienceSynesthesia#4`): 53 pairs exported **76 prefabs, 215 textures, 54 meshes** in 127 s, and every one of the 53
  pairs resolves with its prefab file on disk. The whole `public/assets/local/fx/` directory is 197 MB afterwards. The
  client marks 443 outfits / 6376 distinct variant prefabs, so a whole-client extraction is measured in gigabytes —
  `skinfx.py` is therefore a separate command, never part of the default extraction.
- `fakeProjectiles` keys are **projectile** prefabs, not effect prefabs: a `--fx-keys` run on them answers "no such
  effect prefab", so `skinfx.py` reports them separately instead of asking for them.
- The client's replacement names may differ in case from the set's keys (`…ambienceSynesthesia#4` vs the index's
  lower-case keys): both sides of a pair are lower-cased when written, because the runtime looks a pair up by the
  lower-cased key it is about to play.

## 本机提取的官方时装 (installation outfits)

A cosmetic plugin may never carry files of the official game (docs/PLUGINS.md §9 — plugins get shared), while the
official outfits *are* official files. They therefore live where the rest of the official art lives: under
`public/assets/local/` (git-ignored, extracted from the player's own client), with one metadata sidecar the server
merges into the manifest it serves. Nothing about the choice, the sync, the sim, the protocol or the golden results
changes — the picker simply finds them, exactly like a plugin's outfits.

    tools/local-extract/skins.py            skinpack/<charId>.ab → models, 立绘, 半身像 + data/local-skins.json
      ↓
    public/assets/local/skins/<charId>/<skin>/…   front/back .skel .atlas pages, portrait.png, illust.png
    data/local-skins.json                          { version, skins: { <official skin id>: { charId, name, group, spine, portrait, illust } } }
      ↓
    server/http/assetViews.js `mergeLocalSkins`   merged into the served /data/assets.json (`chars[].skins`)

- **The data** comes from the client's `skinpack/<charId>.ab`: the battle prefab at
  `dyn/battle/prefabs/skins/character/<charId>/<stem>.prefab` binds its `Front` and `Back` renderers to their
  `skeletonDataAsset` references. Follow those references using `extract.py prefab_spine_nodes`, as the default
  operator extractor already does. Container paths compare without case (Unity lower-cases them, while official
  stems can contain `ambienceSynesthesia`). A missing/external reference stays missing; the building prefab is never
  a fallback. The `<stem>b` Sprite supplies the 半身像 (`portrait`), and `<stem>` the full 立绘 (`illust`).
- **Front and Back may have the same skeleton filename.** 惊蛰「遗迹游学者」 binds two distinct TextAssets both named
  `char_306_leizi_game#3.skel`. The old name scan took the first one, which happened to be Back. Its Front was therefore
  a second Back; mirroring LEFT could not repair it. The earlier claim that the client ships no outfit Back was wrong.
  Local re-extraction supplies the faces actually referenced by the prefab; single-model outfits stay Front-only.
  `skin-backs.mjs` remains a legacy fallback for a missing Back only; it cannot correct a wrong Front.
- **Repair an existing installation** with Windows-native Python where the client lives, then regenerate metadata:

  ```powershell
  .venv-extract-win/Scripts/python.exe tools/local-extract/skins.py --game "D:\…\StreamingAssets\AB\Windows" --models-only
  node tools/local-extract/skin-meta.mjs --json
  ```

  `--models-only` restricts the run to installed outfits, skips picture/avatar scans and replaces only each successful
  record's `spine`; it preserves pictures, names, voices and unrelated outfits. A failed outfit retains its old record
  and is reported. `--only <charId>` narrows a pilot run. Back up the installation art and sidecar before replacement;
  deploying source alone does not repair files already extracted on a server. Rebuild the served asset index/catalog
  after installing the repaired files, so new hashes replace the old content identities. Old cached bytes may remain
  stored, but must never answer requests for a different hash.
- **A model entry is not three paths.** `public/js/assets.js` `validSpine` requires `{ skel, atlas, anims }`, and the
  renderer drives the model from `anims` (idle / deploy / attack / skill / die) with `bounds` and `hits` placing it and
  timing its effects. `tools/local-extract/skin-meta.mjs` derives all of it from the skeleton with the same parser and
  role resolver a cosmetic plugin's model goes through (`tools/assets/skel.mjs`, `tools/assets/anim-roles.mjs`) and writes
  it into the sidecar; without it the client refuses the entry ("no spine entry") and the unit silently falls back to the
  operator's own model.
- **The launcher's downloads are an overlay**: content fetched after the install lands under
  `Arknights_Data/PersistentData/Bundles` with the same relative paths, and it wins over the install. `skins.py` reads
  that layer first (`--extra`, default: the client's `PersistentData/Bundles`), so an outfit the launcher downloaded
  after the install is extracted too — three of the 523 on the 2026-10 client exist only there.
  Names, series and ids are the official ones from `skin_table.json` (`displaySkin.skinName`,
  `displaySkin.skinGroupName`, `battleSkin.skinOrPrefabId`), fetched from the Kengxxiao mirror on jsDelivr and cached
  in `.cache/gamedata/excel/` (`--refresh` re-downloads it). An outfit the table names without a battle model is
  skipped, and a file named with `@ # + .` gets a URL-safe directory (`char_003_kalts@boc#6` →
  `char_003_kalts_boc_6` — a `#` in a path is a URL fragment, the page would request only what is before it).
- **The server merges, the client needs nothing**: `mergeLocalSkins` adds each outfit under its operator in the served
  copy of `data/assets.json`, leaving everything else in that document alone (the committed file is never written). An
  outfit the manifest already describes — a bundled record, another sidecar — is kept, and a cosmetic plugin's overlay
  is applied later *on the client*, so a plugin can still override or extend any of it. An operator this build does
  not have (a sidecar from a newer client) is skipped; a record with no model and no picture is dropped; a broken
  model costs the model only, the pictures still play.
- **Run it with the Windows interpreter when the client is on a Windows drive**: `.venv-extract-win/Scripts/python.exe
  tools/local-extract/skins.py --game "D:\…\StreamingAssets\AB\Windows"` — reading the client and writing the pages
  through WSL's `/mnt/…` mount is an order of magnitude slower (the same 4 outfits took ~5 s there against minutes).
  The file names are Windows paths; run it from PowerShell if `python.exe` is not reachable from the shell you use.
- **The in-match shop slot is an avatar slot** (`css/screens/game-shop.css` `.scard__art`): the official shop card draws
  the operator's 180×180 avatar, so that card asks for the avatar and never for the 立绘. The art is sized by the card's
  WIDTH (62%, square, top right, fading into the name strip) — sizing it by the card's height, which a 1:2 portrait could
  afford, made a square avatar as wide as the card is tall and it covered everything.
- **The card picture is a 1:2 crop.** The picker's tile is a fixed 1:2 box (the shape of the 180×360 portrait an
  appearance is chosen by) and the enlarged view letterboxes whatever it is given; an outfit's art from the client is the
  wide splash (~1.25:1). `skins.py` therefore writes `portrait.png` as **full height × half width, centred on the
  figure** (408×817 for a 1022×817 splash) and keeps the untouched splash as `illust.png` (`--crop-portraits` re-crops
  the already extracted files without touching the models).
- **The 180×180 avatars** come from the client's `spritepack/ui_char_avatar_*.ab` (19 shards, read in a couple of
  seconds): the sprite named after the outfit's `avatarId` (`char_003_kalts_boc#6`) is saved as `avatar.png` beside the
  model and named in the record, so a tile shows the outfit's own face instead of the operator's. `--avatars-only`
  (re)writes just those for the outfits already in the sidecar (a few seconds).
- **Not extracted**: the outfits' voice lines — this client install carries no outfit voice packs at all (`audio/`
  holds the ambience and average sounds; the per-operator voices are downloaded on demand into `PersistentData`), so
  they would have to come from the CDN or from an install that played them. The summons' outfit models need the same
  treatment as the operators' (the client packs them in `pkgrps/btl_pfb_tokens_*.ab`) and the sidecar has no
  `tokens` key yet.

## 预缓存 (the asset cache)

The browser pre-cache (素材预缓存, `public/asset-cache-sw.js` + `/api/asset-cache/catalog`) stores bytes **by content
hash** and answers a request only when the requested path is an entry of the pinned catalog's URL map — so an asset the
catalog does not list is simply downloaded again, in the lobby and in a match alike.

- **Outfits and effects are in the catalog** (`server/assetCacheCatalog.js`): it reads the two sidecars beside the
  committed manifests — `data/local-skins.json` (merged into the served `assets.json` before the model lists are built,
  so an outfit's skel/atlas/pages carry the same single model hash the game asks for) and `data/local-fx.json` (the
  official effects). Without them the lobby said "everything cached" and the first outfit in a match still downloaded.
- **Coverage is all of it**: every URL of the served `assets.json` (18 366), `local-assets.json` (1 697) and
  `local-fx.json` (27 642) is a key of the catalog map — outfits 1 653, effects 27 642, nothing missing.
- **Verified in a real browser** (localhost, secure context): an outfit avatar, an outfit model (`.skel`) and an effect
  prefab are first fetched from the network and then served from Cache Storage (`X-SP-Asset-*` on the cached copy), with
  the exact bytes the catalog lists.
- **It needs a secure context.** The feature lives entirely in a Service Worker and Cache Storage: a browser only
  exposes those on HTTPS or `localhost`. The catalogue on a plain-HTTP, IP-address origin (`http://203.0.113.7:5892`)
  reports `isSecureContext: false`, no `serviceWorker`, no `caches` — the 预缓存 panel cannot run there at all (the
  ordinary HTTP cache still works, because the hashed URLs are `immutable`). Serve the game over HTTPS (a tunnel or a
  TLS reverse proxy) if players should use the pre-cache.
- **The catalog has a client-side size cap** (`MAX_MANIFEST_BYTES`, 32 MB): with the outfits and effects the JSON is
  ≈24 MB, so it fits, but it is the number to watch when more extracted art joins the catalog.

## 导出 / 导入 (the envelopes carry the choice)

The 干员调配 screen's 导出 downloads a versioned envelope (`stronghold.loadout`), and its 自选编队 tab one of its own
(`stronghold.diy`). Both may carry the appearance choices, always as the same per-operator map the picker writes
(`{ [charId]: skinId }`, `sp.pref.skins` / `room.skins`):

- **The roster envelope carries the map whole.** A payload from an installation without cosmetic layers — or from a
  build before this one — has no `skins` field at all, and that is meaningful: an absent field leaves the importing
  browser's choices alone. A pair that would make `room.skins` refuse the WHOLE message (a non-charId key, an empty or
  non-string skin id, more than `SKIN_LIMITS.entries` pairs) is dropped at export and again at import, so a file can
  never put the sync into `error` — the same rule `parseStoredSkins` applies to a stored map.
- **The 自选编队 envelope carries its picks' operators only.** A slot wears its pick's operator's skin, so the slot id
  never appears: the file names `{ [charId]: skinId }` for the operators it fields, and an appearance of an operator the
  file does not field stays out of it.
- **Importing merges, never replaces.** What the payload says is written over the current choices per operator; an
  operator the file is silent about keeps what this browser had. That is what makes an older file harmless and two files
  imported one after another coherent.
- **The success toast counts them** (`（含 {n} 名干员的时装）`), so an import that changed appearances says so.

## The switch model: the owner installs, each player switches on

| Who | What they do | Where it is stored |
|---|---|---|
| The server's owner | Drops the plugin folder into `plugins/` (the studio, a ZIP, or by hand), and switches it on for the **room** if they want a set everyone in that room sees | `plugins/`, a room's `vs` |
| A player | Switches a `scope: ["personal"]` cosmetic plugin on for **themself** — a skin of their own choosing | `sp.pref.cosmetics` (this browser only, never sent) |

A room's **host is not part of it**: an appearance a player wears comes from *their* browser's layers, so a plugin with
`scope: ["personal"]` never appears in the room's 插件 panel and no room setting can force a skin on anyone. Two players
of the same co-op match may therefore see different models for the same piece — see the switch below.

## 设置「显示其他玩家的皮肤」 (default on)

A pure client preference (`settings.otherSkins`, `sp.pref.settings`; **never sent**):

- **on** (the default) — a piece draws the appearance its owner chose, which the match published
  (`Match.publicView().players[].skins`, and `UnitInfo.skin` of every unit);
- **off** — every other seat's piece draws the operator's own model and pictures; **this player's own pieces keep their skin**.

The asymmetry is deliberate and is what the setting is for: what you draw is your own choice, what others draw is theirs.
Turning it off hides *their* look from *you* and changes nothing on their screen (public/js/render/app.js `skinOf`). The
renderer decides who is "other" from `UnitInfo.ownerId` and the local `me.playerId`
(public/js/ui/fieldHost.js `setMe`) — never from the seat whose camera happens to be on screen.

[ASSUMED] Switching off retains the received skin ID separately (`sourceSkin`) and derives only the displayed `skin`.
Switching back on restores already loaded units immediately, including a boss partner's read-only prep pieces and
units received while hidden. `room.skins` remains valid in every phase: `Match.setSkins` marks the owner's private
view, which also refreshes existing prep scouts and the boss partner. `fieldHost` forwards public seat choices to
`view.setSkins(players)` on mount and when they change. The current battle's operators use that latest selection
(an omitted `skins` map clears it), even if later spawn metadata carries an older choice. This rebuilds appearance
only: it neither changes the running sim / BattleSpec nor restarts playback. Live refresh timing is a remake UI
choice, not a rule established by the official tables.

## The picker: two display rules

In 干员调配 (`screens/loadout.js Detail`) and in the 自选编队 picker's detail (`screens/diy.js DiyPickerView`), the 皮肤
section sits under the operator's name. 潜能与练度 immediately follows 皮肤 wherever cultivation is offered.
The preserved 0.3.1 order is 皮肤 → 潜能与练度 → 特质 → 技能 → 局内数值 → 模组 in 干员调配, and
皮肤 → 潜能与练度 → 局内数值 → 技能 → 模组 in 自选编队 (prototype picks omit cultivation).
[ASSUMED] This is the existing remake panel order; official tables do not prescribe a skin picker layout.

1. **The section is GLOBAL: every operator shows it, or none does.** The one question `SkinSection` asks is
   `public/js/ui/skins.js hasAnySkinChoices()` — **at least one** operator of the composed manifest has one **wear-able**
   skin (`chars[<charId>].skins[<skinKey>]` with a model or at least one picture). While that is false — no plugin at all,
   a plugin that writes no skins records, or only metadata-only skins — nothing is drawn anywhere, header
   included: an installation without a cosmetic layer looks exactly as it did before this feature.
   While it is true, **every** operator shows the section, including one the plugins wrote no skin for. That operator
   gets the 默认 tile alone, a real picture on it and no empty art box, and the header's note reads `0 套外观`: the count
   is kept at zero on purpose, because the whole point of the global rule is that this box **means something** — "the
   plugin is on, this operator has no 时装". A section hidden per operator said nothing, and left the player unable to
   tell an operator without skins from a plugin that failed to load. This is the **reverse** of the rule this feature
   first shipped with (a per-operator `hasSkinChoices`: 默认 plus a wear-able skin of *that* operator, else no section),
   and it must not be turned back. `hasSkinChoices` remains the single-operator criterion — no production code calls it
   — and is what `hasAnySkinChoices` is counted from, so the two can never disagree about "wear-able".
   The gate counts **wear-able skin records**, including picture-only outfits: a plugin that writes only 立绘 (`chars[<charId>].illust`) and
   no skin turns the section on nowhere, and this picker then shows none of its pictures. That is deliberate — the
   section exists to choose a 时装 and its note counts 套外观, so one replaced 立绘 must not put a `0 套外观` box on every
   operator of the installation. A plugin whose 立绘 has to be seen has to give some operator a wear-able skin (then every
   operator's 默认 tile draws the 立绘 it has, per the rule below), or needs a surface of its own. Should the gate ever be
   meant to count a 立绘 as well, the one line that changes is the body of `hasAnySkinChoices`.
2. **A missing layer falls back to the operator's own art** — a skin with no `portrait` shows the operator's portrait
   (its `illust`, then the portrait), never a slash or a placeholder; the tile is dimmed (`.lo-skin--fallback`) so the
   replacement is legible. The enlarged preview (`.lo-skin-preview`, a `Modal`) shows the skin's 立绘.

The 默认 tile is the operator's **real** appearance, not an empty slot: it draws the operator's own 立绘
(`chars[<charId>].illust` — the picture an appearance plugin may write for an operator it gives no skin at all, and this
tile is the only place that picture is seen), else `chars[<charId>].portrait`, else its avatar. The 立绘 wins over the
portrait on purpose, for the same reason the section is global: what a plugin wrote for the operator has to be visible,
and the 1:2 tile crops to the top exactly as it already does for a skin that ships only an illust. It is never empty
while the record has any of the three; an operator the composed manifest does not hold at all (not even a 默认 tile
exists) gets no section rather than an empty grid.

## New files

| Path | What |
|---|---|
| `public/js/ui/skins.js` | The client store (`sp.pref.skins`, `{ [charId]: skinId }`, at most `SKIN_LIMITS.entries` pairs: `parseStoredSkins` is the one parse of a stored selection — the store's initial state, every edit and what the sync sends — so the wire's own limit is applied where the selection is read), `availableSkins` (the composed manifest's rows, with `playable` and with art already resolved and fallen back; the 默认 row exists for every operator the manifest holds, also one with no `skins`), `hasAnySkinChoices` (the section's global rule), `hasSkinChoices` (the single-operator criterion, kept for tests and future rules), `chosenSkin` (a stored entry that is not one of this operator's wear-able skins counts as 默认), `setSkin` / `clearSkin` |
| `public/js/ui/skinPicker.js` | The 皮肤 section itself: `SkinSection` (nothing while `hasAnySkinChoices` is false — for every operator alike; the 默认 tile alone for an operator without a skin), `SkinPreview` (the enlarged 立绘), the five-tile grid's markup |
| `test/skins.test.js` | The wire shape (`isSkinId` / `isSkinSelection`), the lobby → Match → PlayerState chain, the public view, reconnect, the sim's UnitInfo, the client's fallbacks, and the absence of the install channel |
| `test/lobby-skins.test.js` | `room.skins` over WebSocket: validation, session and seat storage, the seats handed to the Match, bots, the change made mid-match |
| `test/ui/skin-picker.test.js` | The picker's rules against a composed manifest: the rows, `playable`, the art fallbacks, the global `hasAnySkinChoices` and the per-operator `hasSkinChoices`, `chosenSkin`, and that the section's gate is the global one |
| `test/sim/skins-token.test.js` | 召唤物换装 in the engine: a board token after and before its owner, a skill's summon, no skin (the token keeps its own model and the snapshot gains no key) and the same seeded battle twice |
| `public/js/ui/skinPreview.js` | 小人预览: `previewEntry` (the model a row previews), `clipsOf` (the buttons), `SkinModelPreview` (one canvas, mounted and destroyed with the box; PIXI and the asset store loaded lazily) |
| `test/ui/skin-preview.test.js` | The pure half: which model a row previews and which buttons a model offers (roles first, every remaining clip after, never the same clip twice) |
| `test/ui/skin-envelope.test.js` | 导出 / 导入: which map each envelope carries (the roster whole, the 自选 one its picks' operators), that absent means "leave the current choices alone", and that a pair the wire would refuse never reaches the store from a file |
| `test/studio/targets.test.js` | The studio's target index: an outfit is a target of its own under its operator's record, searchable by name / series / operator, and `skin:<key>` reads back although the key carries `@ # + .` |
| `tools/local-extract/skinfx.py` | 官方时装特效's data: read every `skinpack/<charId>.ab`, name each hooker's outfit, write `index.json`'s optional `skinFx` section and print the variant keys a `--fx-keys` run must export |
| `test/render/vfx-skinfx.test.js` | 官方时装特效's runtime: the outfit decides (not the target, for an attack's own effects), a variant the set does not hold falls back to the base key, an older index without the section plays everything as before, and preloading covers the outfits in the battle |
| `tools/local-extract/skins.py` | 本机提取的官方时装: `skinpack/<charId>.ab` → models + 立绘 + 半身像 under `public/assets/local/skins/`, and `data/local-skins.json` (official names from `skin_table.json`) |
| `test/asset-views-skins.test.js` | The served-manifest merge: additive, an outfit the manifest already has is kept, an unknown operator skipped, a record with nothing to show dropped, a broken model costs only the model |
| `public/dev/skin-preview.html` + `public/dev/skin-preview.js` | The browser harness the next row drives (a dev page: `public/dev/` is not shipped, `tools/package.mjs`) |
| `test/render/skin-preview.browser.test.js` | The live half, in a real browser: the canvas appears for a model the machine has, a clip button re-points the same canvas instead of rebuilding it, and unmounting removes it |
| `test/plugins/pack-token.test.js` | The pack's role parsing picks the token rules by the `tokens` path segment (`Skill_1` alone, no operator skill slots) |
| `docs/SKINS.md` | This document |

## Edits to existing files

| File | Where | What |
|---|---|---|
| `shared/protocol.js` | before `isNotOwnedList` | `SKIN_LIMITS` (256 [ASSUMED]), `isSkinId` (**not** `isId`; the same character class as `isSkinKey`), `isCharId`, `isSkinSelection`, `operatorCharIds`, `checkSkinSelection` |
| `shared/protocol.js` | `C2S` | `'room.skins'` — and **no** `'room.skin.install'` |
| `server/net.js` | `HEAVY_TYPES`, `Session` ctor | `'room.skins'`; `session.skins` |
| `server/lobby.js` | after `freezeDiy`, `onMessage`, after `diy()`, `humanSeat`, `seatSettings`, `startMatch` | `freezeSkins` (charId + skinId, drop operators the room lacks; a bad map is BAD_MSG and does not clear), `case 'room.skins'`, `skins()` — **no phase gate**, unlike the loadout — and the selection riding into the match |
| `server/match/PlayerState.js` | ctor | `this.skins = Object.freeze({})` + `setSkins(seat.skins)` |
| `server/match/player/basics.js` | after `setLoadout` | `skinCharIdOf` / `skinFor` / `setSkins` (bots refused; a bad map refused whole, unknown operators dropped) |
| `server/match/match/platform.js` | after `setLoadout` | `setSkins(playerId, skins)` — any phase, `markPrivate()` (owner, prep scouts, boss partner) and `markPublic()` |
| `server/match/match/views.js` | `publicView().players[]`, `_prepBoardUnits`, the scouted bench | `skins` (omitted when empty), and `skin` on every unit the player owns |
| `server/match/player/round.js` | `battleInput` | the unit's `skin`, from the player's own selection and the piece's operator (a 自选 slot follows its pick) |
| `server/match/player/views.js` | `pieceView` | `skin` on the prep board / hand / temp views |
| `server/sim/units.js`, `server/sim/battle/players.js`, `server/sim/snapshot.js` | `Unit`, `_createAllyFromInput` / `_makeAlly`, `unitInfo` | carried to the client; `skin: u.skin ?? undefined`, so a piece without one adds no key to the wire. 召唤物换装 adds two reads of it in `players.js` only: `_makeAlly` inherits `extra.ownerUnit?.skin`, and the late link fills a token whose owner came later (`if (!t.skin) t.skin = owner.skin`) |
| `public/js/assets.js` | `portraitUrl` / `illustUrl` (new) / `spineEntry` / `hasBackSpine` / `unitPictureUrl` / `skinsOf` / `skinHasModel`, and for 召唤物换装 `tokenSkinSpine` + the per-manifest `skinId → charId` map | every helper takes `opts.skin` (the skinId) and falls back to the operator's own art; `spineEntry` asks `tokenSkinSpine` first for a token id, so a summon wears its summoner's outfit's model when that skin names one |
| `public/js/audio.js` | `voiceLine` (6th parameter `skin`), `skinRecordOf` (new), `voice`'s `o.skin`, `_track`'s stored `skin`, the three battle call sites | 皮肤语音: the outfit's line wins in the chosen language, then the operator's dub, then the outfit's Chinese line, then the operator's — and the outfit is resolved by id through the manifest, without importing the asset store (the boot-path pin in `test/ui/plugins-client.test.js`) |
| `public/js/ui/skinPicker.js` | the modal body | 小人预览: `previewEntry` decides it — a row with a model gets `SkinModelPreview`, a picture-only row keeps `SkinPreview` (the enlarged 立绘) |
| `public/css/screens/loadout.css` | end of the picker block | `.lo-spine*`: the constant-shape frame (art layer + mount layer), the clip row and its buttons |
| `shared/plugins/visual.js` | `SKIN_RECORD` / `TOKEN_SKIN_RECORD` / `TOKEN_KEY` / `readFields`' `required` | a skin's `tokens` map (`{ tokenSkinId?, spine }`, `spine` required, at most 64) and the general "a record kind may name required fields" rule it needed |
| `schemas/overlay.schema.json` | `skinRecord.properties.tokens`, `$defs.tokenSkinRecord` | the same contract for the author-side schema, `spine` a `$ref` to the one model definition (`tokens[].spine`) |
| `server/plugins/pack.js` | `opContainer` (the `tokens` path segment wins over the container name) | a skeleton under `…skins.<key>.tokens.<id>.spine` is parsed with the token rules the asset pipeline uses (`skillIndices: [0]`), not an operator's three skill slots |
| `public/js/render/units.js` | `_pictureUrl`, `_modelEntry`, `_wantsBack`, `_loadPicture` | `info.skin` reaches the Spine entry, the diamond and the Front/Back question; the picture's cache key carries the skinId |
| `public/js/render/app.js` | `otherSkins` setting, `ctx.myPlayerId`, `applyInfo`, `refreshSkins`, `setSettings`, `setMe`, `setSkins`, `pieceInfo` | received `sourceSkin` is retained while displayed `skin` follows the switch and latest public selection; a changed appearance drops the view; read-only prep pieces refresh too |
| `public/js/render/app/info.js` | `renderInfo` | `skin` |
| `public/js/ui/loadoutSync.js` | header, `installSkinsSync` | the fourth `installPrefSync` setting (`room.skins { skins }`) |
| `public/js/main.js` | boot | `installSkinsSync({ net })` |
| `public/js/ui/settings.js` | `CosmeticSection` | the 显示其他玩家的皮肤 switch — with or without a cosmetic plugin |
| `public/js/ui/gameLogic/settings.js` | `DEFAULT_SETTINGS`, `sanitizeSettings` | `otherSkins: true` |
| `public/js/ui/fieldHost.js` | mount, store subscription, `OPTIONAL` | `view.setMe` and `view.setSkins` adopt and follow local identity / public seat choices; unmount removes the subscription |
| `public/css/screens/loadout.css` | end | `.lo-skins` / `.lo-skin*` tiles, `.lo-skin-preview` |
| `public/i18n/*.json` | — | the strings above, in every pack (`node tools/i18n.mjs check --all --strict`) |

## Invariants

- **No `cs`.** An appearance is never part of a room's content set: it changes nothing a battle does, so no battle
  identity moves for it (docs/PLUGINS.md §6).
- **No `server/sim/` rule.** The sim carries `skin` as opaque data (`Unit.skin` → `unitInfo().skin`); no rule reads it
  (`server/sim/units.js` stores it, `battle/players.js` copies it onto the ally, `snapshot.js` publishes it). The same
  seeded battle run with and without a skin returns the same `Battle.result()` (`test/skins.test.js`), and
  `test/golden/*.json` is unchanged. `skin` is listed with the sim fields in `docs/design/engine.md` §5.2 and
  `docs/SIM.md` §2 as display-only.
- **No `data/` write.** Nothing in this feature writes a data file; a plugin's own files are served from
  `plugins/<id>/` under `/p/<id>/<hash>/…` (docs/PLUGINS.md §9).
- **No game art in git.** As ever: skin art belongs to a plugin (or to a locally extracted client), never to this
  repository.
- **A bad map is refused whole.** `isSkinSelection` / `validateC2S` (`room.skins`), the lobby (`freezeSkins` / `skins()`)
  and `PlayerState.setSkins` all require a plain object, a charId key (`isCharId`: official `char_<digits>_<token>` or
  a plugin `char_x_…`, never a chess id) and a skinId value (`isSkinId`). An array, a null-prototype object, one bad
  key or value, or more than 256 entries [ASSUMED] is BAD_MSG and does **not** clear a choice already stored. A charId
  the room's content does not have (`operatorCharIds`: chess records, `backups.units`, `diy.ownedPool`,
  `diy.operators`) is dropped and the rest kept, so the stored map is at most that operator count. An unknown skinId
  of an operator the room does have still draws the default model (`spineEntry`).
- **The client never sends more than the wire accepts.** `SKIN_LIMITS.entries` (256 [ASSUMED]) is applied in
  `public/js/ui/skins.js parseStoredSkins`, the one place a stored selection is read — the store's initial state, every
  edit and the `room.skins` payload the sync prepares. The limit has to be honoured there because an over-long map is not
  trimmed entry by entry on the server: `isSkinSelection` refuses the WHOLE message (BAD_MSG), so nothing would be stored
  and the sync would sit in `error` (public/js/ui/loadoutSync.js `installPrefSync`) instead of saving the rest.
- **A tile never outgrows the panel it sits in.** `.lo-skins` is `repeat(5, minmax(0, 1fr))` (three columns below 900 px,
  where the detail panel is a whole phone width — or a narrow window — and tall enough for the 1:2 box), so a tile is a
  share of the detail panel and its size never moves with how many skins an operator has. The tile draws the appearance's
  1:2 portrait, and on a panel too short for that box it draws the same appearance's 1:1 `avatar` instead —
  `@media (max-width: 1000px) and (max-height: 520px)` at the end of the picker's block in
  `public/css/screens/loadout.css`. That query is a phone in landscape: its detail panel is 193–263 px tall (measured
  740×360 … 932×430) while the 1:2 tile is 264–379 px there, which made 皮肤 the ONE section of that panel a phone could
  not see whole (潜能与练度 / 技能 / 局内数值 / 模组 are 135–163 px in the same panel). Both images of a tile are in the DOM
  (`public/js/ui/skinPicker.js`, `availableSkins().avatar`) and CSS alone decides, so no resize listener and no re-render;
  273/273 of the installed skins ship an `avatar` of their own (measured), and a row whose manifest has none keeps its
  portrait on every screen. A 1:2 box is still what every wider panel draws, with `min-height: max(1.5rem, 130px)` as
  the floor of a narrow one. Portrait is not a case to solve: a portrait phone is covered by 「请将设备横屏」
  (`public/index.html .rotate-hint`, shown by `public/css/theme.css`
  `@media (orientation: portrait) and (max-width: 1024px) { .sp-rotatable .rotate-hint { display: grid } }` for the
  `sp-rotatable` that `public/js/ui/device.js` sets on a coarse pointer whose screen is not landscape).

## Known limitations

Preview lifecycle (2026-10-22 fork maintenance): a cancelled preview releases only its own model reference,
including loads that finish after it closes. Offscreen / background previews stop their ticker and resume the same
canvas on return; closing a preview frees that renderer's GPU objects. High-DPR previews avoid redundant MSAA.
The in-game mobile resolution adjustment is independently switchable in settings; see
[mobile performance](development/MOBILE_PERFORMANCE.md).

- **Bots always wear the default model** (`PlayerState.setSkins` refuses a bot, as `setLoadout` does).
- **The studio lists the skins the manifest already has** (P7): the target picker finds one by the outfit's name, its
  series or its operator, and `skin:<key>` names it — the key carries `@ # + .`, so it is copied from there rather than
  typed (`server/studio/targets.js`). A skin the installation does not have yet is still written by hand or in the stem
  form: the studio cannot invent an outfit.
- **No skin effects and no operator voices** (a separate piece of work; docs/ASSETS.md).
- **A summon keeps the look it was placed with**: its model is read once, when the unit is built with the battle input,
  so a change made mid-battle reaches the next battle (operators refresh immediately instead). A prep board's token
  piece keeps its own model until it deploys, and a summon's avatar is never restyled — see 召唤物换装 above.
- **An outfit that ships only Chinese lines is heard only by 中文 players**: a player whose 语音语言 is Japanese keeps
  the operator's Japanese lines even where the outfit has a Chinese take for that slot (see 皮肤语音 above). The 试听
  dropdown does not preview outfit lines either.
- **A 自选 slot's own record has `charId: null`**, so it wears its **pick's** operator's skin — the slot has no body of
  its own. The picker offers the appearance while picking that operator, and the choice is kept per operator, so
  changing the slot's operator changes the appearance with it.
