/** 生成登录二维码。只在本机计算，不向任何地方发送内容。 */
import { encode } from 'uqr';

/** 二维码点阵：true 为黑。四周留 4 格白边，方便手机识别。 */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: 4 }).data;
}

/** 把点阵转成一条 SVG 路径（同一行相邻的黑格合并成一段） */
export function qrPath(matrix: boolean[][]): string {
  let d = '';
  for (let y = 0; y < matrix.length; y++) {
    const row = matrix[y]!;
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      d += `M${x} ${y}h${end - x}v1h${x - end}z`;
      x = end;
    }
  }
  return d;
}
