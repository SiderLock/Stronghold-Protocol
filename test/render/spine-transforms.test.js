import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix, Transform } from '@pixi/math';
import { optimizeSpineTransforms } from '../../public/js/render/spineTransforms.js';

test('batched bone decomposition retains native properties and matrices across rotation, shear, scale and pivot', t => {
  const old = globalThis.PIXI;
  globalThis.PIXI = { Transform, Matrix };
  t.after(() => { if (old === undefined) delete globalThis.PIXI; else globalThis.PIXI = old; });
  const a = new Transform(), b = new Transform(), parent = new Transform();
  optimizeSpineTransforms({ slotContainers: [{ transform: b }] });
  assert.notEqual(a.setFromMatrix, b.setFromMatrix);
  const matrix = new Matrix();
  for (let i = 0; i < 2000; i++) {
    const rotation = i / 17, shear = i % 3 ? i / 31 : 0;
    matrix.set(Math.cos(rotation) * (i % 5 - 2), Math.sin(rotation) * (i % 5 - 2),
      -Math.sin(rotation - shear) * 1.4, Math.cos(rotation - shear) * 1.4, i / 3, -i / 7);
    a.pivot.set(i % 3, i % 7); b.pivot.copyFrom(a.pivot);
    a.setFromMatrix(matrix); b.setFromMatrix(matrix);
    for (let translated = 0; translated < 3; translated++) {
      matrix.tx += 0.31; matrix.ty -= 0.7;
      a.setFromMatrix(matrix); b.setFromMatrix(matrix);
      a.updateTransform(parent); b.updateTransform(parent);
      assert.deepEqual(b.localTransform, a.localTransform);
      assert.deepEqual(b.worldTransform, a.worldTransform);
    }
    for (const key of ['position', 'scale', 'skew', 'pivot']) {
      assert.equal(b[key].x, a[key].x, `${key}.x at ${i}`);
      assert.equal(b[key].y, a[key].y, `${key}.y at ${i}`);
    }
    assert.equal(b.rotation, a.rotation);
    parent.position.set(i % 13, i % 17); parent.updateTransform(Transform.IDENTITY);
    a.updateTransform(parent); b.updateTransform(parent);
    assert.deepEqual(b.localTransform, a.localTransform);
    assert.deepEqual(b.worldTransform, a.worldTransform);
    // Subsequent ordinary transform edits still work, including retained ObservablePoint references.
    a.position.x += 2; b.position.x += 2;
    a.rotation += 0.1; b.rotation += 0.1;
    a.updateTransform(parent); b.updateTransform(parent);
    assert.deepEqual(b.worldTransform, a.worldTransform);
  }
});

test('custom and unsupported transforms are not modified', t => {
  const old = globalThis.PIXI;
  globalThis.PIXI = { Transform, Matrix };
  t.after(() => { if (old === undefined) delete globalThis.PIXI; else globalThis.PIXI = old; });
  class Custom extends Transform {}
  const tr = new Custom(), original = tr.setFromMatrix;
  optimizeSpineTransforms({ slotContainers: [{ transform: tr }] });
  assert.equal(tr.setFromMatrix, original);
  optimizeSpineTransforms(null);
});

test('changing both skew axes recalculates trig values once instead of once per setter', t => {
  const old = globalThis.PIXI;
  globalThis.PIXI = { Transform, Matrix };
  t.after(() => { if (old === undefined) delete globalThis.PIXI; else globalThis.PIXI = old; });
  let calls = 0;
  const updateSkew = Transform.prototype.updateSkew;
  t.mock.method(Transform.prototype, 'updateSkew', function () { calls++; return updateSkew.call(this); });
  const a = new Transform(), b = new Transform();
  optimizeSpineTransforms({ slotContainers: [{ transform: b }] });
  a.rotation = b.rotation = 0.5;
  const matrix = new Matrix(1, 0.3, 0.4, 1, 3, 4);
  calls = 0; a.setFromMatrix(matrix); const nativeCalls = calls;
  calls = 0; b.setFromMatrix(matrix);
  assert.equal(nativeCalls, 3);
  assert.equal(calls, 1);
  a.updateLocalTransform(); b.updateLocalTransform();
  assert.deepEqual(b.localTransform, a.localTransform);
});
