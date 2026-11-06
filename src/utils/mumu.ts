import type { AdbDevice, MuMuBinding, MuMuSettings } from '../types/maa';

export function getMuMuBinding(config: string): MuMuBinding | undefined {
  try {
    const mumu = JSON.parse(config)?.extras?.mumu;
    if (
      mumu?.enable === true &&
      typeof mumu.path === 'string' &&
      mumu.path.trim() &&
      Number.isInteger(mumu.index) &&
      mumu.index >= 0
    ) {
      return { path: mumu.path, index: mumu.index };
    }
  } catch {
    // 普通 ADB 设备不一定提供模拟器扩展配置。
  }
  return undefined;
}

export function sameMuMuInstance(a: MuMuBinding, b: MuMuBinding): boolean {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return a.index === b.index && normalize(a.path) === normalize(b.path);
}

export function saveAdbDevice(device: AdbDevice, previous?: MuMuSettings) {
  const binding = getMuMuBinding(device.config);
  return {
    adbDeviceName: device.name,
    adbDeviceAddress: device.address,
    mumu: binding
      ? {
          ...binding,
          autoStart: !!previous?.autoStart && sameMuMuInstance(binding, previous),
          autoShutdown: !!previous?.autoShutdown && sameMuMuInstance(binding, previous),
        }
      : undefined,
  };
}
