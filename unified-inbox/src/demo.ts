/** 演示模式的虚构数据：不联网，所有人名和对话都是编的 */
import { MockNetwork } from './core/mock-backend.ts';
import type { StoredAccount } from './core/vault.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface DemoChat {
  id: number;
  title: string;
  kind?: 'user' | 'group' | 'channel' | 'bot';
  muted?: boolean;
  lines: [who: 'in' | 'out', text: string, ago: number, extra?: { sender?: string; photo?: boolean; unread?: boolean }][];
}

const DEMO: { phone: string; name: string; label: string; color: string; chats: DemoChat[] }[] = [
  {
    phone: '+8613800000011',
    name: '陈经理',
    label: '客户号',
    color: '#2f7de1',
    chats: [
      {
        id: 101,
        title: '王老板（杭州）',
        lines: [
          ['in', '上次那批货的报价能再给我发一下吗', 2 * DAY],
          ['out', '好的王总，报价单稍后发您', 2 * DAY - 5 * MIN],
          ['in', '收到了，价格可以', DAY],
          ['in', '这周能发货吗？', 6 * MIN, { unread: true }],
          ['in', '我这边比较急', 5 * MIN, { unread: true }],
        ],
      },
      {
        id: 102,
        title: '李小姐',
        lines: [
          ['in', '你好，想咨询一下起订量', 3 * HOUR],
          ['out', '您好，起订量是 200 件', 3 * HOUR - 2 * MIN],
          ['in', '可以先拿样品吗', 40 * MIN, { unread: true }],
        ],
      },
      {
        id: 103,
        title: '华东客户群',
        kind: 'group',
        lines: [
          ['in', '新款图片发一下', 5 * HOUR, { sender: '赵敏' }],
          ['out', '', 5 * HOUR - MIN, { photo: true }],
          ['in', '好看，有蓝色吗', 4 * HOUR, { sender: '周涛' }],
          ['in', '我要 50 件', 25 * MIN, { sender: '赵敏', unread: true }],
        ],
      },
      { id: 104, title: '张先生', lines: [['in', '发票已收到，谢谢', 3 * DAY], ['out', '不客气，合作愉快', 3 * DAY - MIN]] },
    ],
  },
  {
    phone: '+8613800000033',
    name: '陈经理',
    label: '供应商号',
    color: '#e0683a',
    chats: [
      {
        id: 201,
        title: '顺达包装厂',
        lines: [
          ['out', '纸箱这周能到吗', 8 * HOUR],
          ['in', '周四发车，周五到', 7 * HOUR],
          ['in', '物流单号发您了，注意查收', 12 * MIN, { unread: true }],
        ],
      },
      {
        id: 202,
        title: '刘厂长',
        lines: [
          ['in', '面料涨价了，下个月开始每米加 2 块', 2 * HOUR, { unread: true }],
        ],
      },
      { id: 203, title: '原料供应商群', kind: 'group', muted: true, lines: [['in', '今日行情已更新', 90 * MIN, { sender: '行情助手', unread: true }]] },
      { id: -1000000000777, title: '行业资讯', kind: 'channel', muted: true, lines: [['in', '本周原材料价格周报', 6 * HOUR, { unread: true }]] },
    ],
  },
  {
    phone: '+8613800000055',
    name: '小陈',
    label: '售后号',
    color: '#2aa876',
    chats: [
      {
        id: 301,
        title: '买家 阿杰',
        lines: [
          ['in', '收到的有一件尺码不对', 50 * MIN],
          ['in', '', 49 * MIN, { photo: true }],
          ['in', '能换吗', 48 * MIN, { unread: true }],
        ],
      },
      { id: 302, title: '买家 小雨', lines: [['in', '快递显示签收了但我没收到', 20 * HOUR], ['out', '我帮您联系快递核实', 20 * HOUR - 3 * MIN], ['in', '找到了，在驿站，谢谢', 19 * HOUR]] },
    ],
  },
];

export function seedDemo(net: MockNetwork): StoredAccount[] {
  net.latency = 180;
  return DEMO.map((acc, i) => {
    const u = net.ensureUser(acc.phone, acc.name);
    const userId = u.self.userId;
    for (const chat of acc.chats) {
      net.addChat(userId, chat.id, chat.title, chat.kind ?? 'user', { muted: chat.muted ?? false });
      for (const [who, text, ago, extra] of [...chat.lines].sort((a, b) => b[2] - a[2])) {
        net.seed(userId, chat.id, text, { out: who === 'out', ago, ...extra });
      }
    }
    return {
      id: `demo-${i + 1}`,
      label: acc.label,
      color: acc.color,
      phone: acc.phone,
      userId,
      name: acc.name,
      username: null,
      session: `mock-session:${userId}:demo`,
    };
  });
}

/** 演示里每隔一会儿自动来一条新消息，方便看到「实时汇总」的效果 */
export function startDemoTraffic(net: MockNetwork): void {
  const script: [phone: string, chatId: number, text: string, sender?: string][] = [
    ['+8613800000033', 201, '司机电话 138****5521，到了会联系您'],
    ['+8613800000011', 102, '样品费怎么算？'],
    ['+8613800000055', 301, '在吗？麻烦尽快处理一下'],
    ['+8613800000011', 103, '蓝色我也要 30 件', '周涛'],
    ['+8613800000033', 202, '老客户价格可以再谈'],
  ];
  let i = 0;
  setInterval(() => {
    const [phone, chatId, text, sender] = script[i % script.length]!;
    i++;
    net.deliver(net.userIdForPhone(phone), chatId, text, sender);
  }, 15_000);
}
