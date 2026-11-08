import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getMuMuBinding,
  isMuMuSavedDevice,
  MUMU_REALTIME_INTERVAL_MS,
  saveAdbDevice,
  sameMuMuInstance,
} from '../src/utils/mumu.ts';

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

test('MuMu selection saves pure identity (path + index) without legacy toggles', () => {
  assert.deepEqual(saveAdbDevice(device), {
    adbDeviceName: device.name,
    adbDeviceAddress: device.address,
    mumu: { ...binding },
  });
});

test('reselecting or switching MuMu instances updates binding cleanly', () => {
  const previous = { path: 'c:/program files/mumu/', index: 0 };
  const saved = saveAdbDevice(device, previous);
  assert.deepEqual(saved.mumu, { ...binding });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
  assert.equal(sameMuMuInstance(binding, { ...binding, path: 'c:/program files/mumu/' }), true);
  assert.equal(sameMuMuInstance(binding, { ...binding, path: 'D:/MuMu' }), false);
});

test('ordinary or manually entered ADB connections have no MuMu lifecycle settings', () => {
  const previous = { ...binding };
  const saved = saveAdbDevice({ ...device, config: '{}' }, previous);
  assert.equal(saved.mumu, undefined);
  assert.equal('mumu' in JSON.parse(JSON.stringify(saved)), false);
  assert.equal(saved.adbDeviceName, device.name);
  assert.equal(saved.adbDeviceAddress, device.address);
});

test('isMuMuSavedDevice detects saved mumu binding or matching discovered MuMu ADB device', () => {
  assert.equal(MUMU_REALTIME_INTERVAL_MS, 40);
  assert.equal(
    isMuMuSavedDevice({
      adbDeviceAddress: device.address,
      mumu: { ...binding },
    }),
    true,
  );
  assert.equal(isMuMuSavedDevice({ adbDeviceAddress: device.address }, [device]), true);
  assert.equal(
    isMuMuSavedDevice({ adbDeviceAddress: device.address }, [{ ...device, config: '{}' }]),
    false,
  );
  assert.equal(isMuMuSavedDevice(undefined, [device]), false);
});
