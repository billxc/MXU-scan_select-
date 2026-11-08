import type { AdbDevice, MuMuBinding, MuMuSettings } from '../types/maa';
import type { SavedDeviceInfo } from '../types/interface';

/** MuMu 实时预览默认帧间隔（ms，40ms = 25 FPS） */
export const MUMU_REALTIME_INTERVAL_MS = 40;

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

export function isMuMuSavedDevice(
  savedDevice: SavedDeviceInfo | undefined,
  adbDevices: readonly AdbDevice[] = [],
): boolean {
  if (savedDevice?.mumu) {
    return true;
  }
  const address = savedDevice?.adbDeviceAddress;
  const name = savedDevice?.adbDeviceName;
  if (!address && !name) {
    return false;
  }
  const matched =
    (address && adbDevices.find((d) => d.address === address)) ||
    (name && adbDevices.find((d) => d.name === name));
  return matched ? Boolean(getMuMuBinding(matched.config)) : false;
}

export function sameMuMuInstance(a: MuMuBinding, b: MuMuBinding): boolean {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return a.index === b.index && normalize(a.path) === normalize(b.path);
}

export function saveAdbDevice(device: AdbDevice, _previous?: MuMuSettings) {
  const binding = getMuMuBinding(device.config);
  return {
    adbDeviceName: device.name,
    adbDeviceAddress: device.address,
    mumu: binding ? { ...binding } : undefined,
  };
}
