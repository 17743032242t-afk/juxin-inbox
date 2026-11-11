/** 演示版本里用它顶替真实连接代码，保证演示页面里完全没有联网能力 */
export class MtcuteBackend {
  constructor() {
    throw new Error('演示版本不包含真实连接。');
  }
}
