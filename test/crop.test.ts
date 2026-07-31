import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_SPEC, describeCrop, parseCropSpec, resolveCropRect } from "../src/crop.js";

test("no-crop spellings all disable cropping", () => {
  for (const value of ["none", "None", "off", "false", "", "   ", undefined, null]) {
    assert.equal(parseCropSpec(value), null, `expected no crop for ${JSON.stringify(value)}`);
  }
});

test("auto trims the right edge, where Gemini stamps its mark", () => {
  assert.deepEqual(parseCropSpec("auto"), AUTO_SPEC);
  assert.deepEqual(AUTO_SPEC.right, { value: 10, unit: "pct" });
  assert.deepEqual(AUTO_SPEC.top, { value: 0, unit: "px" });
  assert.deepEqual(AUTO_SPEC.bottom, { value: 0, unit: "px" });
});

test("named sides parse independently", () => {
  const spec = parseCropSpec("bottom:6%,left:12px")!;
  assert.deepEqual(spec.bottom, { value: 6, unit: "pct" });
  assert.deepEqual(spec.left, { value: 12, unit: "px" });
  assert.deepEqual(spec.top, { value: 0, unit: "px" });
  assert.deepEqual(spec.right, { value: 0, unit: "px" });
});

test("CSS-style 1, 2 and 4 value forms", () => {
  const one = parseCropSpec("10")!;
  assert.deepEqual([one.top, one.right, one.bottom, one.left].map((i) => i.value), [10, 10, 10, 10]);

  const two = parseCropSpec("5%,10px")!;
  assert.deepEqual(two.top, { value: 5, unit: "pct" });
  assert.deepEqual(two.right, { value: 10, unit: "px" });
  assert.deepEqual(two.bottom, { value: 5, unit: "pct" });
  assert.deepEqual(two.left, { value: 10, unit: "px" });

  const four = parseCropSpec("1,2,3,4")!;
  assert.deepEqual([four.top, four.right, four.bottom, four.left].map((i) => i.value), [1, 2, 3, 4]);
});

test("units are per-value and px is the default", () => {
  const spec = parseCropSpec("48px,3%,0,7")!;
  assert.deepEqual(spec.top, { value: 48, unit: "px" });
  assert.deepEqual(spec.right, { value: 3, unit: "pct" });
  assert.deepEqual(spec.bottom, { value: 0, unit: "px" });
  assert.deepEqual(spec.left, { value: 7, unit: "px" });
});

test("bad specs throw instead of cropping the wrong region", () => {
  for (const value of ["1,2,3", "bottom", "sideways:4px", "bottom:huge", "-5", "abc", "bottom:4:5"]) {
    assert.throws(() => parseCropSpec(value), /crop|Crop/i, `expected throw for "${value}"`);
  }
});

test("resolveCropRect converts percentages against the right axis", () => {
  // 10% of height off the bottom, 10% of width off the left.
  const spec = parseCropSpec("bottom:10%,left:10%")!;
  assert.deepEqual(resolveCropRect(spec, 1000, 500), { x: 100, y: 0, width: 900, height: 450 });
});

test("resolveCropRect handles pixels and all four sides together", () => {
  const spec = parseCropSpec("10,20,30,40")!;
  assert.deepEqual(resolveCropRect(spec, 200, 100), { x: 40, y: 10, width: 140, height: 60 });
});

test("a zero crop is reported as a no-op", () => {
  assert.equal(resolveCropRect(parseCropSpec("0")!, 100, 100), null);
  assert.equal(resolveCropRect(parseCropSpec("0%")!, 100, 100), null);
});

test("percentages round to whole pixels", () => {
  const rect = resolveCropRect(parseCropSpec("bottom:3%")!, 1024, 1024)!;
  assert.equal(rect.height, 1024 - 31); // 30.72 rounds to 31
  assert.equal(rect.width, 1024);
});

test("a crop that consumes the image throws rather than writing a 0-pixel file", () => {
  assert.throws(() => resolveCropRect(parseCropSpec("50%")!, 100, 100), /entire image/);
  assert.throws(() => resolveCropRect(parseCropSpec("bottom:100%")!, 100, 100), /entire image/);
  assert.throws(() => resolveCropRect(parseCropSpec("60px")!, 100, 100), /entire image/);
});

test("auto against the real result size measured from a live generation", () => {
  const rect = resolveCropRect(AUTO_SPEC, 1024, 559)!;
  assert.deepEqual(rect, { x: 0, y: 0, width: 922, height: 559 });
  assert.equal(describeCrop(rect, { width: 1024, height: 559 }), "cropped 1024x559 -> 922x559 (offset 0,0)");
});
