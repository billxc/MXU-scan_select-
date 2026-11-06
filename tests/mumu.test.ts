import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getMuMuBinding, saveAdbDevice, sameMuMuInstance } from '../src/utils/mumu.ts';

const binding = { path: 'C:\\Program Files\\MuMu', index: 2 };
const device = {
  name: 'MuMu instance 2',
  address: '127.0.0.1:16448',
  adb_path: 'C:\\Program Files\\MuMu\\nx_main\\adb.exe',
  screencap_methods: '1',
  input_methods: '1',
  config: JSON.stringify({ extras: { mumu: { enable: true, ...binding } } }),
};

test('MuMu binding requires enabled discovery extras, not an ADB address or device name', () => {
  assert.deepEqual(getMuMuBinding(device.config), binding);
  for (const config of [
    '',
    '{}',
    'invalid',
    'null',
    JSON.stringify({ extras: { mumu: { ...binding, enable: false } } }),
    JSON.stringify({ extras: { mumu: { ...binding, enable: true, index: -1 } } }),
    JSON.stringify({ extras: { mumu: { ...binding, enable: true, index: '2' } } }),
    JSON.stringify({ extras: { mumu: { ...binding, enable: true, path: '' } } }),
  ]) {
    assert.equal(getMuMuBinding(config), undefined);
  }
});

test('first MuMu selection saves identity with both toggles off', () => {
  assert.deepEqual(saveAdbDevice(device), {
    adbDeviceName: device.name,
    adbDeviceAddress: device.address,
    mumu: { ...binding, autoStart: false, autoShutdown: false },
  });
});

test('reselecting the same MuMu preserves all four independent toggle combinations', () => {
  for (const autoStart of [false, true]) {
    for (const autoShutdown of [false, true]) {
      const previous = { path: 'c:/program files/mumu/', index: 2, autoStart, autoShutdown };
      const saved = saveAdbDevice(device, previous);
      assert.deepEqual(saved.mumu, { ...binding, autoStart, autoShutdown });
      assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
    }
  }
});

test('switching MuMu instances resets toggles rather than applying the old policy', () => {
  const previous = { ...binding, index: 0, autoStart: true, autoShutdown: true };
  assert.deepEqual(saveAdbDevice(device, previous).mumu, {
    ...binding,
    autoStart: false,
    autoShutdown: false,
  });
  assert.equal(sameMuMuInstance(binding, { ...binding, path: 'D:/MuMu' }), false);
});

test('ordinary or manually entered ADB connections have no MuMu lifecycle settings', () => {
  const previous = { ...binding, autoStart: true, autoShutdown: true };
  const saved = saveAdbDevice({ ...device, config: '{}' }, previous);
  assert.equal(saved.mumu, undefined);
  assert.equal('mumu' in JSON.parse(JSON.stringify(saved)), false);
  assert.equal(saved.adbDeviceName, device.name);
  assert.equal(saved.adbDeviceAddress, device.address);
});
