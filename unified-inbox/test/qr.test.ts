import assert from 'node:assert/strict';
import { test } from 'node:test';
import jsQR from 'jsqr';
import { qrMatrix, qrPath } from '../src/core/qr.ts';

const URL = 'tg://login?token=AQJ3k1mZ0b7Qw2xYc9d8e7f6g5h4i3j2k1l0m9n8o7p6q5r4s3t2u1v0wA';

/** 把点阵放大成一张黑白图片，交给独立的二维码识别库去读 */
function decode(matrix: boolean[][], scale = 4): string | null {
  const size = matrix.length * scale;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = matrix[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
      pixels.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  return jsQR(pixels, size, size)?.data ?? null;
}

test('生成的二维码能被独立的识别库读出，内容与原文完全一致', () => {
  assert.equal(decode(qrMatrix(URL)), URL);
  assert.equal(decode(qrMatrix('tg://login?token=short')), 'tg://login?token=short');
});

test('二维码四周留有白边，是正方形', () => {
  const m = qrMatrix(URL);
  assert.ok(m.every((row) => row.length === m.length));
  for (let i = 0; i < 4; i++) {
    assert.ok(m[i]!.every((v) => !v));
    assert.ok(m[m.length - 1 - i]!.every((v) => !v));
    assert.ok(m.every((row) => !row[i] && !row[row.length - 1 - i]));
  }
});

test('画到屏幕上的路径与点阵逐格一致', () => {
  const m = qrMatrix(URL);
  const painted = m.map((row) => row.map(() => false));
  for (const seg of qrPath(m).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(seg[1]), Number(seg[2]), Number(seg[3])];
    for (let i = 0; i < w; i++) painted[y]![x + i] = true;
  }
  assert.deepEqual(painted, m);
});
