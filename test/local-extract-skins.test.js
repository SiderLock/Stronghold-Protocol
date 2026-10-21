// Synthetic Unity prefab references only; no client, UnityPy, official art or network is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PY = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0);
const TOOL = path.resolve('tools/local-extract');
const FIXTURE = `
from types import SimpleNamespace as NS
class Obj:
 def __init__(self,kind,tree): self.type=NS(name=kind); self.tree=tree
 def read_typetree(self): return self.tree
def ptr(pid,external=0): return {'m_PathID':pid,'m_FileID':external}
def component(pid): return {'component':ptr(pid)}
def node(pid,name,sda,children=(),external=0):
 objects[pid]=Obj('GameObject',{'m_Name':name,'m_IsActive':0 if name=='Back' else 1,
  'm_Component':[component(pid+1),component(pid+2)]})
 objects[pid+1]=Obj('Transform',{'m_GameObject':ptr(pid),'m_Children':[ptr(c+1) for c in children]})
 objects[pid+2]=Obj('MonoBehaviour',{'skeletonDataAsset':ptr(sda,external)})
objects={}
# Both TextAssets have the SAME name; the old name scan takes whichever comes first.
for pid in [301,302,303]:
 objects[pid]=Obj('TextAsset',{'m_Name':'char_9001_test_demo#1.skel'})
 objects[pid-100]=Obj('MonoBehaviour',{'skeletonJSON':ptr(pid),'atlasAssets':[], 'marker':pid})
node(10,'Front',201)
node(20,'Back',202)
node(30,'Spine',203)
node(40,'battle',0,[10,20])
node(50,'building',0,[30])
prefab='dyn/battle/prefabs/skins/character/char_9001_test/char_9001_test_demo#1.prefab'
env=NS(container={prefab:objects[40],
 'dyn/building/vault/characters/build_char_9001_test_demo#1.prefab':objects[50]})
def faces(): return {k:v['marker'] for k,v in skins.battle_faces(env,objects,'char_9001_test','char_9001_test_demo#1').items()}
`;

function py(code) {
  const r = spawnSync(PY, ['-B', '-c', `import sys,json\nsys.path.insert(0,${JSON.stringify(TOOL)})\nimport skins\n${FIXTURE}\n${code}`],
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('outfit faces follow battle prefab references even with duplicate names, reversed object order and inactive Back', { skip: !PY }, () => {
  const results = py(`results=[faces()]
objects=dict(reversed(list(objects.items())))
results.append(faces())
env.container={'/'+k.upper():v for k,v in env.container.items()}
results.append(faces())
print(json.dumps(results))`);
  assert.deepEqual(results, Array(3).fill({ front: 301, back: 302 }));
});

test('missing battle prefabs or external renderer references never pick a dorm or an unrelated same-name skeleton', { skip: !PY }, () => {
  assert.deepEqual(py(`results=[]
objects[22].tree['skeletonDataAsset']=ptr(202,1)
results.append(faces())
del env.container[prefab]
results.append(faces())
print(json.dumps(results))`), [{ front: 301 }, {}]);
});

test('a single Spine of the battle prefab is wearable; a Back-only prefab never becomes Front', { skip: !PY }, () => {
  assert.deepEqual(py(`env.container[prefab]=objects[50]
results=[faces()]
env.container[prefab]=objects[20]
results.append(faces())
print(json.dumps(results))`), [{ front: 303 }, { back: 302 }]);
});

test('models-only repair preserves pictures and unrelated outfits, skips sprite scans, and dry-run leaves sidecar intact', { skip: !PY }, () => {
  const result = py(`import tempfile,contextlib,io
from pathlib import Path
sid='char_9001_test@demo#1'
before={sid:{'charId':'char_9001_test','name':'custom','avatar':'avatar.png','portrait':'portrait.png',
 'illust':'illust.png','voice':{'select':'voice.mp3'},'spine':{'front':{'skel':'old'}}},
 'char_9002_other@x#1':{'charId':'char_9002_other','spine':{'front':{'skel':'keep'}}}}
with tempfile.TemporaryDirectory() as tmp:
 skins.ROOT=Path(tmp); (skins.ROOT/'data').mkdir()
 sidecar=skins.ROOT/'data/local-skins.json'
 sidecar.write_text(json.dumps({'version':1,'skins':before}))
 skins.skin_table=lambda *a,**kw: {'fixture':True}
 skins.default_extra=lambda *a: None
 skins.named_skins=lambda *a,**kw: [{'skinId':sid,'charId':'char_9001_test','stem':'char_9001_test_demo#1'},
  {'skinId':'not_installed','charId':'char_9003_new'}]
 def no_scan(*a,**kw): raise Exception('unneeded image scan')
 skins.avatar_map=no_scan
 calls=[]
 def export(*a,**kw):
  assert kw['models_only'] and kw['avatars']=={}
  calls.append(a[1]['skinId'])
  return {'entry':{'spine':{'front':{'skel':'correct-front'},'back':{'skel':'correct-back'}}},'files':6}
 skins.export_outfit=export
 raw=sidecar.read_bytes()
 with contextlib.redirect_stdout(io.StringIO()): skins.main(['--game',tmp,'--models-only','--dry-run'])
 unchanged=raw==sidecar.read_bytes()
 with contextlib.redirect_stdout(io.StringIO()): skins.main(['--game',tmp,'--models-only'])
 after=json.loads(sidecar.read_text())['skins']
 print(json.dumps({'before':before,'after':after,'calls':calls,'dryUnchanged':unchanged}))`);
  assert.equal(result.dryUnchanged, true);
  assert.deepEqual(result.calls, ['char_9001_test@demo#1', 'char_9001_test@demo#1']);
  const sid = 'char_9001_test@demo#1';
  assert.deepEqual(result.after, { ...result.before, [sid]: { ...result.before[sid], spine: {
    front: { skel: 'correct-front' }, back: { skel: 'correct-back' },
  } } });
});
