// Pixi 7 decomposes a Spine bone matrix into rotation, skew and scale. Its separate skew/rotation
// setters can recalculate the same four trig values several times per pose. Batch those assignments
// only on owned, standard slot transforms; all public properties and native world matrices agree.
function setBoneMatrix(matrix) {
  const a = matrix.a, b = matrix.b, c = matrix.c, d = matrix.d;
  const skewX = -Math.atan2(-c, d), skewY = Math.atan2(b, a);
  const delta = Math.abs(skewX + skewY);
  const rotationOnly = delta < 1e-5 || Math.abs(Math.PI * 2 - delta) < 1e-5;
  const rotation = rotationOnly ? skewY : 0;
  const x = rotationOnly ? 0 : skewX, y = rotationOnly ? 0 : skewY;
  let changed = false;
  if (this._rotation !== rotation) { this._rotation = rotation; changed = true; }
  if (this.skew._x !== x) { this.skew._x = x; changed = true; }
  if (this.skew._y !== y) { this.skew._y = y; changed = true; }
  if (changed) this.updateSkew();
  this.scale.x = Math.sqrt(a * a + b * b);
  this.scale.y = Math.sqrt(c * c + d * d);
  this.position.x = matrix.tx + (this.pivot.x * a + this.pivot.y * c);
  this.position.y = matrix.ty + (this.pivot.x * b + this.pivot.y * d);
  this._localID++;
}

export function optimizeSpineTransforms(spine) {
  const Transform = globalThis.PIXI?.Transform;
  if (!Transform || !Array.isArray(spine?.slotContainers)) return;
  for (const slot of spine.slotContainers) {
    const tr = slot.transform;
    // Version-bound adapter: custom runtimes/transforms and replacements keep the native path.
    if (tr?.constructor !== Transform || tr.setFromMatrix !== Transform.prototype.setFromMatrix
      || tr.updateSkew !== Transform.prototype.updateSkew || typeof tr._localID !== 'number'
      || typeof tr.skew?._x !== 'number' || typeof tr.skew?._y !== 'number') continue;
    tr.setFromMatrix = setBoneMatrix;
  }
}
