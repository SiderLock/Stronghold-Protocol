"""官方时装 (official outfits): read the client's skinpack bundles and write them as INSTALLATION art.

Our skins come from cosmetic-plugin overlays (docs/SKINS.md) and a plugin may never carry official files — so the
official outfits live where the other official art lives: `public/assets/local/` (git-ignored), with one metadata
sidecar `data/local-skins.json` that the server merges into the served asset manifest (server/http/assetViews.js).
A player then sees the outfits in the picker exactly like a plugin's, with no plugin installed.

Per outfit, from `skinpack/<charId>.ab`:
  spine front / back   the battle prefab's Front / Back renderers → SkeletonDataAssets → .skel + .atlas + pages
                       (tools/local-extract/extract.py write_spine: atlas pages sized, `pma: true`)
  portrait             the `<charId>_<stem>b` Sprite (the 半身像 the cards use)
  illust               the `<charId>_<stem>` Sprite (the full 立绘, ~2550 px wide)
Names / series / ids come from the official `skin_table.json` (Kengxxiao mirror via jsDelivr, cached in
`.cache/gamedata/excel/`): `displaySkin.skinName`, `displaySkin.skinGroupName`, `battleSkin.skinOrPrefabId`.

  .venv/bin/python tools/local-extract/skins.py [--game <AB root>] [--only char_003_kalts,…] [--limit N]
                                               [--out public/assets/local] [--dry-run] [--refresh] [--json]

Writes `public/assets/local/skins/<charId>/<stem>/{front,back}/…`, `portrait.png`, `illust.png` and merges
`data/local-skins.json`:
  { version: 1, source: {client, table}, skins: { <skinId>: { charId, name, group, avatar?, portrait, illust,
                                                            spine: { front: {skel,atlas,textures}, back? } } } }
`--dry-run` only reports (what it would write, how many files, which outfits have no model / no picture).
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

SKIN_TABLE_CACHE = ROOT / '.cache' / 'gamedata' / 'excel' / 'skin_table.json'
SKIN_TABLE_URL = ('https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/'
                  'skin_table.json')
SIDEcar = 'local-skins.json'


def default_extra(ab_root):
    """The client's overlay bundles (`<game>/Arknights_Data/PersistentData/Bundles`): content the launcher downloaded
    after the install — new outfits among it. Same relative paths as the install, the overlay wins where both exist."""
    p = Path(ab_root).parents[2] / 'PersistentData' / 'Bundles'
    return p if p.exists() else None


def bundle_of(ab_root, extra, rel):
    """The bundle for `rel` (`skinpack/<charId>.ab`): the overlay's copy when it has one, else the install's."""
    for base in ([extra] if extra else []) + [ab_root]:
        p = Path(base) / rel
        if p.exists():
            return p
    return None


def dir_stem(stem):
    """A URL-safe directory name for an outfit stem: `@`, `#`, `+` and other non-`[A-Za-z0-9._-]` become `_`
    (`char_003_kalts_sale#14` → `char_003_kalts_sale_14`) — a `#` in a path is a URL fragment and the page would
    request only what is before it."""
    return re.sub(r'[^A-Za-z0-9._-]', '_', stem)


def _game_root(value):
    if value:
        return Path(value)
    import extract
    found = next((p for p in extract.CANDIDATES if p.exists()), None)
    if not found:
        sys.exit('skins: no local client found (pass --game <AB root>)')
    return found


def skin_table(refresh=False):
    """The official skin table (cached; `--refresh` downloads again). Never fatal — the extractor may run with none."""
    if refresh or not SKIN_TABLE_CACHE.exists():
        SKIN_TABLE_CACHE.parent.mkdir(parents=True, exist_ok=True)
        try:
            import urllib.request
            req = urllib.request.Request(SKIN_TABLE_URL, headers={'User-Agent': 'stronghold-protocol/0.3.1'})
            with urllib.request.urlopen(req, timeout=120) as r:
                blob = r.read()
            if len(blob) < 100_000:
                raise ValueError(f'too small ({len(blob)} bytes)')
            SKIN_TABLE_CACHE.write_bytes(blob)
        except Exception as e:  # noqa: BLE001
            print(f'  warn: skin_table.json not refreshed ({e}); using the cached one if any', file=sys.stderr)
    try:
        return json.loads(SKIN_TABLE_CACHE.read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001
        return None


def named_skins(table, only=None):
    """The outfits to export: `[{skinId, charId, stem, name, group}]`, in table order, filtered by `only` (charIds) and
    to those whose `battleSkin` or id names a real battle model."""
    out = []
    for skin_id, rec in (table.get('charSkins') or {}).items():
        char_id = rec.get('charId')
        if not char_id or not skin_id.startswith(f'{char_id}@'):
            continue
        if only and char_id not in only:
            continue
        battle = rec.get('battleSkin') or {}
        stem = battle.get('skinOrPrefabId') if isinstance(battle.get('skinOrPrefabId'), str) else None
        if not stem:
            # no battle model of its own (a 立绘-only variant): the outfit is still wearable in-game only through its
            # pictures, which the manifest sidecar cannot express — skip it and count it
            continue
        ds = rec.get('displaySkin') or {}
        out.append({'skinId': skin_id, 'charId': char_id, 'stem': stem,
                    'name': ds.get('skinName') or stem, 'group': ds.get('skinGroupName') or ''})
    return out


def _sprites(env):
    """Every Sprite of the bundle: {name: PIL image} (the largest image wins when a name repeats)."""
    out = {}
    for o in env.objects:
        if o.type.name != 'Sprite':
            continue
        try:
            d = o.read()
            nm = getattr(d, 'm_Name', '') or ''
            img = getattr(d, 'image', None)
        except Exception:  # noqa: BLE001
            continue
        if not nm or img is None:
            continue
        if nm not in out or img.size[0] * img.size[1] > out[nm].size[0] * out[nm].size[1]:
            out[nm] = img
    return out


AVATAR_GLOB = 'spritepack/ui_char_avatar_*.ab'


def avatar_map(ab_root, log=print, extra=None):
    """Every 180×180 outfit avatar the client ships: {avatarName: PIL image}, `char_003_kalts_boc#6` — the avatarId
    `skin_table.json` names for the outfit (the official skin id with `@` written as `_`). The whole set is 19 shards
    and reads in a couple of seconds, so it is built once per run."""
    import aklz4  # noqa: F401  (registers the LZ4AK decoder)
    import UnityPy
    out = {}
    files = []
    for root in ([extra] if extra else []) + [ab_root]:
        files.extend(sorted((Path(root) / 'spritepack').glob(Path(AVATAR_GLOB).name)))
    for f in files:
        try:
            env = UnityPy.load(str(f))
        except Exception:  # noqa: BLE001
            continue
        for o in env.objects:
            if o.type.name != 'Sprite':
                continue
            try:
                d = o.read()
                nm = getattr(d, 'm_Name', '') or ''
                img = getattr(d, 'image', None)
            except Exception:  # noqa: BLE001
                continue
            if nm and img is not None and nm not in out:
                out[nm] = img
    log(f'  avatars: {len(out)} sprites in {len(files)} shards')
    return out


def _sanitize_pages(out_root, sub, group, log):
    """URL-safe page file names inside one model directory: a page is named after the client's texture, which may carry
    `#` (`build_char_003_kalts_boc#6.png`) — a `#` in a path is a URL fragment and the page would 404. The atlas names
    its pages, so its text is rewritten to match. Returns the (possibly re-keyed) manifest group."""
    out_dir = Path(out_root) / sub
    pages = {k: v for k, v in group.items() if k.endswith('.png')}
    remap = {old: dir_stem(old.removesuffix('.png')) + '.png' for old in pages if dir_stem(old.removesuffix('.png')) + '.png' != old}
    if not remap:
        return group
    for old, new in remap.items():
        src = out_dir / old
        if src.exists():
            src.replace(out_dir / new)
        group.pop(old, None)
        group[new] = {**pages[old], 'path': pages[old]['path'].rsplit('/', 1)[0] + '/' + new}
    for name in [k for k in group if k.endswith('.atlas')]:
        f = out_dir / name
        if not f.exists():
            continue
        text = f.read_text(encoding='utf-8', errors='replace')
        for old, new in remap.items():
            text = text.replace(old, new)
        f.write_text(text, encoding='utf-8')
    log(f'  pages renamed in {sub}: {", ".join(f"{a}→{b}" for a, b in remap.items())}')
    return group


def card_portrait(img):
    """The 1:2 card portrait of a splash art.

    The client's tile is a FIXED 1:2 box (the shape of the 180x360 portrait an appearance is chosen by,
    css/screens/loadout.css .lo-skin__art), while an outfit's art is the wide splash (~1.25:1 in the client's `b`
    sprite): dropped into that box it is cropped hard, and in the enlarged view it shrinks to letterbox. So the card
    copy is cropped here: full height, width = height / 2, centred on the figure (official splashes put the character
    at the horizontal centre; the window keeps the whole figure from head to feet, which is what a card portrait
    shows). The splash itself stays as `illust`."""
    w, h = img.size
    if h <= 0 or abs(w - h / 2) <= 2:
        return img
    cw = max(1, h // 2)
    left = min(max(0, w // 2 - cw // 2), max(0, w - cw))
    return img.crop((left, 0, left + cw, h))


def battle_faces(env, objects, char_id, stem):
    """Resolve the battle prefab's renderer references, never the skeleton TextAsset names.

    Front and Back can have the SAME TextAsset name (`char_306_leizi_game#3.skel`); picking the first name match
    makes object order decide which face gets exported. The prefab already binds each face unambiguously.
    Missing/external references stay missing; the building prefab is never a battle-model fallback.
    """
    from extract import prefab_spine_nodes
    prefab = f'dyn/battle/prefabs/skins/character/{char_id}/{stem}.prefab'
    # Unity's container paths are lower-case even when the official stem uses ambienceSynesthesia.
    root = next((ref for key, ref in env.container.items() if key.lstrip('/').lower() == prefab.lower()), None)
    if root is None:
        return {}
    faces = {}
    nodes = prefab_spine_nodes(root.read_typetree(), objects)
    for name, _active, ref in nodes:
        face = name.lower()
        # Bard outfits (空 / 浊心斯卡蒂) bind one undirected Spine, as default/token extraction also supports.
        if len(nodes) == 1 and face == 'spine':
            face = 'front'
        obj = objects.get(ref.get('m_PathID')) if not ref.get('m_FileID') else None
        if face in ('front', 'back') and obj is not None:
            sda = obj.read_typetree()
            if 'skeletonJSON' in sda and 'atlasAssets' in sda:
                faces[face] = sda
    return faces


def export_outfit(ab_root, skin, out_root, dry=False, log=print, avatars=None, extra=None, models_only=False):
    """One outfit → its files; returns {files: {rel: bytes|PIL}, manifest entry} or {'error': …}."""
    import aklz4  # noqa: F401  (registers the LZ4AK decoder)
    import UnityPy
    import extract as X

    char_id, stem, skin_id = skin['charId'], skin['stem'], skin['skinId']
    pack = bundle_of(ab_root, extra, f'skinpack/{char_id}.ab')
    if pack is None:
        return {'error': 'no skinpack bundle'}
    env = UnityPy.load(str(pack))
    objs = list(env.objects)
    by_pid = {o.path_id: o for o in objs}

    faces = battle_faces(env, by_pid, char_id, stem)
    if 'front' not in faces:
        return {'error': 'no front model in battle prefab'}

    files, manifest = {}, {}
    for face, tt in faces.items():
        sub = f'skins/{char_id}/{dir_stem(stem)}/{face}'
        n = X.write_spine(by_pid, tt, sub, f'{stem}_{face}', out_root if not dry else '/tmp/skins-dryrun', manifest, log)
        if n == 0:
            return {'error': f'model {face} incomplete'}
        if not dry:
            _sanitize_pages(out_root, sub, manifest.get(sub, {}), log)
    # pictures: the 半身像 `<stem>b` and the full 立绘 `<stem>`
    sprites = {} if models_only else _sprites(env)
    pics = {}
    for key, name in (('portrait', f'{stem}b'), ('illust', stem)):
        img = sprites.get(name)
        if img is not None:
            pics[key] = (f'skins/{char_id}/{dir_stem(stem)}/{key}.png', card_portrait(img) if key == 'portrait' else img)

    entry = {'charId': char_id, 'name': skin['name'], 'group': skin['group']}
    for face in ('front', 'back'):
        if face not in faces:
            continue
        sub = f'skins/{char_id}/{dir_stem(stem)}/{face}'
        group = manifest.get(sub, {})
        skel = next((v['path'] for k, v in group.items() if k.endswith('.skel')), None)
        atlas = next((v['path'] for k, v in group.items() if k.endswith('.atlas')), None)
        texs = [v['path'] for k, v in group.items() if k.endswith('.png')]
        if not skel or not atlas:
            return {'error': f'model {face} missing skel/atlas'}
        entry.setdefault('spine', {})[face] = {'skel': skel, 'atlas': atlas, 'textures': texs}
    for key, (rel, img) in pics.items():
        entry[key] = f'/assets/local/{rel}'
    # the 180×180 avatar (skin_table avatarId); absent for an outfit the client gives none
    av_name = skin['skinId'].replace('@', '_')
    av = (avatars or {}).get(av_name)
    if av is not None:
        rel = f'skins/{char_id}/{dir_stem(stem)}/avatar.png'
        entry['avatar'] = f'/assets/local/{rel}'
        pics['avatar'] = (rel, av)
    if not dry:
        out = Path(out_root)
        for rel, img in pics.values():
            dest = out / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            img.save(dest)
    return {'entry': entry, 'files': len(manifest.get(f'skins/{char_id}/{dir_stem(stem)}/front', {}))
            + len(pics) + len(manifest.get(f'skins/{char_id}/{dir_stem(stem)}/back', {}))}


def main(argv=None):
    ap = argparse.ArgumentParser(description='export official outfits as installation art (data/local-skins.json)')
    ap.add_argument('--game', help='AB root of the local client (default: the known install locations)')
    ap.add_argument('--out', default=str(ROOT / 'public/assets/local'), help='the extracted asset root')
    ap.add_argument('--only', default='', metavar='charId,…', help='these operators only')
    ap.add_argument('--limit', type=int, default=0, metavar='N', help='stop after N outfits')
    ap.add_argument('--dry-run', action='store_true', help='report only, write nothing')
    ap.add_argument('--models-only', action='store_true', help='repair installed outfits Front/Back; preserve pictures and other fields')
    ap.add_argument('--refresh', action='store_true', help='download skin_table.json again')
    ap.add_argument('--extra', help='overlay bundle root the launcher downloaded into (default: the client\'s PersistentData)')
    ap.add_argument('--json', action='store_true', help='JSON summary')
    ap.add_argument('--crop-portraits', action='store_true',
                    help='re-crop the already extracted portrait.png files to the 1:2 card shape')
    ap.add_argument('--avatars-only', action='store_true',
                    help='only (re)write the 180x180 avatars of the outfits already in data/local-skins.json')
    a = ap.parse_args(argv)
    log = (lambda s: print(s, file=sys.stderr, flush=True)) if not a.json else (lambda s: None)

    ab_root = _game_root(a.game)
    extra = Path(a.extra) if a.extra else default_extra(ab_root)
    table = skin_table(a.refresh)
    if not table:
        sys.exit('skins: no skin table (network needed for the first run: --refresh)')
    only = {x.strip() for x in a.only.split(',') if x.strip()} or None
    wanted = named_skins(table, only)
    if a.limit:
        wanted = wanted[:a.limit]
    if a.crop_portraits:
        sidecar0 = ROOT / 'data' / SIDEcar
        doc = json.loads(sidecar0.read_text(encoding='utf-8'))
        from PIL import Image  # noqa: PLC0415  (Pillow only where images are read)
        n = 0
        for skin_id, rec in (doc.get('skins') or {}).items():
            url = rec.get('portrait')
            if not isinstance(url, str) or not url.startswith('/assets/'):
                continue
            rel = url.removeprefix('/assets/')
            if rel.startswith('local/'):        # --out IS public/assets/local
                rel = rel[len('local/'):]
            dest = Path(a.out) / rel
            if not dest.exists():
                continue
            im = Image.open(dest).convert('RGBA')
            if not a.dry_run:
                card_portrait(im).save(dest)
            n += 1
        print(json.dumps({'portraits': n, 'written': 0 if a.dry_run else n}, ensure_ascii=False))
        return 0
    if a.avatars_only:
        avatars = avatar_map(ab_root, log, extra=extra)
        sidecar0 = ROOT / 'data' / SIDEcar
        doc = json.loads(sidecar0.read_text(encoding='utf-8'))
        n = 0
        for skin_id, rec in (doc.get('skins') or {}).items():
            av = avatars.get(skin_id.replace('@', '_'))
            if av is None:
                continue
            skel = (((rec.get('spine') or {}).get('front') or {}).get('skel') or '')
            m = re.match(r'/assets/local/(skins/[^/]+/[^/]+)/', skel)
            if not m:
                continue
            rel = f'{m.group(1)}/avatar.png'
            if not a.dry_run:
                dest = Path(a.out) / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                av.save(dest)
            rec['avatar'] = f'/assets/local/{rel}'
            n += 1
        if not a.dry_run:
            tmp = sidecar0.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            tmp.replace(sidecar0)
        print(json.dumps({'outfits': n, 'written': 0 if a.dry_run else n}, ensure_ascii=False))
        return 0
    sidecar = ROOT / 'data' / SIDEcar
    prev = {}
    try:
        prev = json.loads(sidecar.read_text(encoding='utf-8')).get('skins') or {}
    except Exception:  # noqa: BLE001
        prev = {}
    if a.models_only:
        wanted = [skin for skin in wanted if skin['skinId'] in prev]
    out, errors, files = dict(prev), [], 0
    avatars = {} if a.dry_run or a.models_only else avatar_map(ab_root, log, extra=extra)
    t0 = time.time()
    for i, skin in enumerate(wanted, 1):
        got = export_outfit(ab_root, skin, a.out, dry=a.dry_run, log=log, avatars=avatars, extra=extra,
                            models_only=a.models_only)
        if 'error' in got:
            errors.append(f"{skin['skinId']}: {got['error']}")
        else:
            out[skin['skinId']] = ({**prev[skin['skinId']], 'spine': got['entry']['spine']}
                                   if a.models_only else got['entry'])
            files += got['files']
        if i % 25 == 0:
            log(f'  skins: {i}/{len(wanted)}…')
    summary = {'outfits': len(wanted), 'exported': len(out) - len(prev), 'errors': len(errors), 'files': files,
               'total': len(out), 'seconds': round(time.time() - t0, 1)}
    if not a.dry_run and out:
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        doc = {'version': 1, 'source': {'client': ab_root.name, 'table': 'skin_table.json'}, 'skins': out}
        tmp = sidecar.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        tmp.replace(sidecar)
    print(json.dumps(summary, ensure_ascii=False))
    for e in errors[:10]:
        print('  ' + e, file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
