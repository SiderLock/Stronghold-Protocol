"""官方时装特效 (skin FX): read the client's CharacterSkinHookers and write index.json's `skinFx` section.

An outfit in Arknights may replace its operator's effects: the client attaches a `CharacterSkinHooker` to every outfit
prefab, and its `_replaceEffectPairs` is a list of `{ fromEffect, toEffect }` — "when this unit plays `from`, play `to`
instead". A few hundred outfits do this (443 skins / 6590 pairs on the 2026-10 build), including the shared keys
(`common_char_birth_01` → `kalts_birth_01_boc#6`), so a skin can change an operator's birth effect too.

  .venv/bin/python tools/local-extract/skinfx.py [--game <AB root>] [--out public/assets/local]
                                                [--only char_003_kalts,char_1033_swire2] [--keys-out /tmp/k.txt]

Writes into the fx index the extractor already produced (`<out>/fx/index.json`):
  skinFx: { <skinId>: { replace: { <fromEffect>: <toEffect>, … },
                        fakeProjectiles?: [{ originalProjectileKey, graphicProjectileKey, logicProjectileKey,
                                             muzzlePoint }] } }
`skinId` is the official one: the hooker's GameObject is named `<charId>_<stem>`, and the outfit of that operator is
`<charId>@<stem>` (`char_003_kalts_boc#6` → `char_003_kalts@boc#6`) — the same rule the skin catalogue follows.

The REPLACEMENT keys are new effect prefabs, and the runtime can only play what the fx set has: this script prints them
and `--keys-out` saves them, for a follow-up extraction run that exports those prefabs into the same set:

  .venv/bin/python tools/local-extract/extract.py --only fx --fx-keys $(paste -sd, /tmp/k.txt)

Nothing here changes the index's `version`: `skinFx` is an OPTIONAL section (an index without it, or an outfit without
an entry, plays the base effects exactly as before), so an older set stays readable and a newer runtime ignores it.

Reading the hookers needs no ANIMATOR walk: every one of the 426 skinpack bundles was read in 108 s on this machine, so
the default is the whole client; `--only` narrows it while iterating.
"""

import argparse
import json
import sys
import time
from pathlib import Path

SKINPACK_GLOB = 'skinpack/*.ab'


def _ab_root(value):
    """The AB root: the argument, else the extractor's known install locations (extract.py CANDIDATES)."""
    if value:
        return Path(value)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import extract  # noqa: WPS433  (the one place the install locations live)
    found = next((p for p in extract.CANDIDATES if p.exists()), None)
    if not found:
        sys.exit('skinfx: no local client found (pass --game <AB root>)')
    return found


def scan(ab_root, only=None, log=None):
    """Every CharacterSkinHooker under `<ab_root>/skinpack`: {skinId: {replace, fakeProjectiles}}.

    `only` keeps those operators (a set of charIds). Unreadable bundles are counted and skipped — one broken pack must
    not cost the other 425.
    """
    import aklz4  # noqa: F401  (registers the LZ4AK decoder)
    import UnityPy

    root = Path(ab_root) / SKINPACK_GLOB
    files = sorted(root.parent.glob(root.name))
    out, bad = {}, 0
    t0 = time.time()
    for i, f in enumerate(files, 1):
        char_id = f.stem
        if only and char_id not in only:
            continue
        try:
            env = UnityPy.load(str(f))
            objs = list(env.objects)
        except Exception:  # noqa: BLE001  (a broken pack: counted, not fatal)
            bad += 1
            continue
        names = {}
        for o in objs:
            if o.type.name != 'GameObject':
                continue
            try:
                names[o.path_id] = o.read_typetree().get('m_Name', '')
            except Exception:  # noqa: BLE001
                pass
        for o in objs:
            if o.type.name != 'MonoBehaviour':
                continue
            try:
                tt = o.read_typetree()
            except Exception:  # noqa: BLE001
                continue
            pairs = tt.get('_replaceEffectPairs')
            if not pairs:
                continue
            name = names.get(tt.get('m_GameObject', {}).get('m_PathID', 0)) or ''
            stem = name[len(char_id) + 1:] if name.startswith(char_id + '_') else ''
            if not stem:
                continue
            # keys are lower-cased on both sides: index.json's effect keys are lower-case by convention, and the
            # runtime looks the pair up with the key it plays (differencing-case client names like
            # `swire2_attack_01_hit_ambienceSynesthesia#4` would otherwise never match)
            clean = {p['fromEffect'].lower(): p['toEffect'].lower() for p in pairs
                     if p.get('fromEffect') and p.get('toEffect')}
            if not clean:
                continue
            rec = {'replace': clean}
            cfgs = tt.get('_fakeProjectileConfigs') or []
            if tt.get('_useFakeProjectile') and cfgs:
                # the outfit's own projectile art (an operator whose projectile is drawn by the skin): the keys are
                # effect prefabs of the same set, muzzlePoint the client's muzzle mount index
                rec['fakeProjectiles'] = [{
                    'originalProjectileKey': c.get('originProjectileKey'),
                    'graphicProjectileKey': c.get('graphicProjectileKey'),
                    'logicProjectileKey': c.get('logicProjecitleKey'),   # the client's own typo
                    'muzzlePoint': c.get('_fakeMuzzlePoint'),
                } for c in cfgs if c.get('graphicProjectileKey')]
            out[f'{char_id}@{stem}'] = rec
        if log and i % 100 == 0:
            log(f'  skinfx: {i}/{len(files)} bundles…')
    return {'skins': out, 'bundles': len(files), 'bad': bad, 'seconds': round(time.time() - t0, 1)}


def target_keys(skins):
    """The effect keys the replacements play (deduplicated, in a stable order) — what a `--fx-keys` run must export.

    Only the `replace` values: they are effect prefabs of the same set. The `fakeProjectiles` keys are PROJECTILE
    prefabs (a different container — `projectile_chr_kalts` and friends are not under the effects the fx run indexes, a
    `--fx-keys` run on them logs "no such effect prefab"), and the runtime does not consume them yet; they are reported
    separately rather than asked for here.
    """
    keys = []
    seen = set()
    for rec in skins.values():
        for k in rec['replace'].values():
            if k and k not in seen:
                seen.add(k)
                keys.append(k)
    return keys


def fake_projectile_keys(skins):
    """The `fakeProjectiles` keys (not effect prefabs; see target_keys) — reported, not exported."""
    keys = []
    for rec in skins.values():
        for c in rec.get('fakeProjectiles') or []:
            for k in (c.get('graphicProjectileKey'), c.get('logicProjectileKey')):
                if k and k not in keys:
                    keys.append(k)
    return keys


def merge(index_path, skins):
    """Write the `skinFx` section into an existing index.json (skins it already lists are replaced wholesale: the
    client is the source of truth). Returns (skins written, target keys that the index does not hold yet)."""
    index_path = Path(index_path)
    index = json.loads(index_path.read_text(encoding='utf-8')) if index_path.exists() else {}
    index['skinFx'] = {k: skins[k] for k in sorted(skins)}
    prefabs = index.get('prefabs') or {}
    missing = [k for k in target_keys(skins) if k.lower() not in prefabs]
    index_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = index_path.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    tmp.replace(index_path)
    return len(index['skinFx']), missing


def main(argv=None):
    ap = argparse.ArgumentParser(description='write index.json skinFx from the client skinpacks')
    ap.add_argument('--game', help='AB root of the local client (default: the known install locations)')
    ap.add_argument('--out', default='public/assets/local', help='the extracted asset root (default public/assets/local)')
    ap.add_argument('--only', default='', metavar='charId,…', help='these operators only (default: every skinpack)')
    ap.add_argument('--json', action='store_true', help='print the summary as JSON')
    ap.add_argument('--keys-out', metavar='PATH', help='write the replacement keys here, one per line')
    ap.add_argument('--dry-run', action='store_true', help='scan and report, write nothing')
    a = ap.parse_args(argv)

    ab_root = _ab_root(a.game)
    only = {x.strip() for x in a.only.split(',') if x.strip()} or None
    log = (lambda s: print(s, file=sys.stderr, flush=True)) if not a.json else None
    got = scan(ab_root, only, log)
    skins = got['skins']
    keys = target_keys(skins)
    if a.keys_out:
        Path(a.keys_out).write_text('\n'.join(keys) + ('\n' if keys else ''), encoding='utf-8')
    written, missing = (0, [])
    if not a.dry_run:
        written, missing = merge(Path(a.out) / 'fx' / 'index.json', skins)
    summary = {
        'bundles': got['bundles'], 'bad': got['bad'], 'skins': len(skins),
        'pairs': sum(len(r['replace']) for r in skins.values()),
        'withFake': sum(1 for r in skins.values() if r.get('fakeProjectiles')),
        'targetKeys': len(keys), 'fakeProjectileKeys': len(fake_projectile_keys(skins)),
        'written': written, 'notInIndex': len(missing), 'seconds': got['seconds'],
    }
    print(json.dumps(summary, ensure_ascii=False) if a.json else json.dumps(summary, ensure_ascii=False, indent=1))
    if missing:
        print('not yet in the fx set (run extract.py --only fx --fx-keys …): ' + ', '.join(missing[:8])
              + (', …' if len(missing) > 8 else ''), file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
