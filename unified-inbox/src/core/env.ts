/**
 * 登录时向官方服务器说明「我是什么设备、什么系统、什么语言」。
 *
 * 原则：如实、稳定。
 * - 如实：报的是这台设备真实的浏览器和系统，不冒充官方客户端，也不编造设备。
 *   冒充一旦被识别，正是最典型的「登录环境异常」。
 * - 稳定：同一台设备每次报的内容一致，不随机变化。忽隐忽现的设备信息同样会被当作异常。
 */
export interface ClientEnvironment {
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  systemLangCode: string;
  langCode: string;
}

export const APP_VERSION = '0.1.0';

function browserOf(ua: string): string {
  const pick = (re: RegExp, name: string): string | null => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge') ??
    pick(/OPR\/(\d+)/, 'Opera') ??
    pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/FxiOS\/(\d+)/, 'Firefox') ??
    pick(/CriOS\/(\d+)/, 'Chrome') ??
    pick(/Chrome\/(\d+)/, 'Chrome') ??
    pick(/Version\/(\d+)[\d.]* .*Safari\//, 'Safari') ??
    'Browser'
  );
}

function systemOf(ua: string): string {
  let m: RegExpExecArray | null;
  if ((m = /Android (\d+(?:\.\d+)?)/.exec(ua))) return `Android ${m[1]}`;
  if (/Android/.test(ua)) return 'Android';
  if ((m = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/.exec(ua))) return `iOS ${m[1]}.${m[2]}`;
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

export function describeClient(userAgent: string, language: string): ClientEnvironment {
  const lang = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(language) ? language : 'en';
  return {
    deviceModel: browserOf(userAgent),
    systemVersion: systemOf(userAgent),
    appVersion: APP_VERSION,
    systemLangCode: lang,
    langCode: lang.split('-')[0]!.toLowerCase(),
  };
}
