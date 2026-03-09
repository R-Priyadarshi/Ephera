import { buildInviteQrPayload } from '../invite-qr.js';
import { parseInvitePackageText } from '../invite-package.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runInviteQrPayloadTest() {
  console.log('--- STARTING INVITE QR PAYLOAD TEST ---');

  {
    const payload = buildInviteQrPayload({
      roomId: 'room-qr',
      roomJoinKey: 'abcdef0123456789abcdef0123456789',
      joinLink: 'https://ephera.test/index.html?roomId=room-qr#roomJoinKey=abcdef0123456789abcdef0123456789',
      passphrase: 'pass-qr',
    });
    assert(typeof payload === 'string' && payload.length > 0, 'FAIL: expected non-empty QR payload');

    let obj = null;
    try { obj = JSON.parse(payload); } catch {}
    assert(!!obj, 'FAIL: QR payload must be valid JSON');
    assert(obj.v === 1, 'FAIL: QR payload version mismatch');
    assert(obj.roomId === 'room-qr', 'FAIL: QR payload roomId mismatch');
    assert(obj.roomJoinKey === 'abcdef0123456789abcdef0123456789', 'FAIL: QR payload roomJoinKey mismatch');
    assert(obj.passphrase === 'pass-qr', 'FAIL: QR payload passphrase mismatch');

    const parsed = parseInvitePackageText(payload);
    assert(parsed.ok === true, 'FAIL: parser should accept QR JSON payload');
    assert(parsed.roomId === 'room-qr', 'FAIL: parser roomId mismatch for QR payload');
    assert(parsed.roomJoinKey === 'abcdef0123456789abcdef0123456789', 'FAIL: parser roomJoinKey mismatch for QR payload');
    assert(parsed.passphraseSeen === true, 'FAIL: parser passphraseSeen mismatch for QR payload');
    assert(parsed.passphrase === 'pass-qr', 'FAIL: parser passphrase mismatch for QR payload');
  }

  {
    const payload = buildInviteQrPayload({
      roomId: '',
      roomJoinKey: 'abcdef0123456789abcdef0123456789',
      joinLink: 'https://ephera.test/index.html?roomId=x#roomJoinKey=abcdef0123456789abcdef0123456789',
    });
    assert(payload === '', 'FAIL: missing roomId should produce empty payload');
  }

  {
    const payload = buildInviteQrPayload({
      roomId: 'room-qr',
      roomJoinKey: 'bad@key',
      joinLink: 'https://ephera.test/index.html?roomId=room-qr',
    });
    assert(payload === '', 'FAIL: invalid roomJoinKey should produce empty payload');
  }

  {
    const payload = buildInviteQrPayload({
      roomId: 'room-qr-no-pass',
      roomJoinKey: '00112233445566778899aabbccddeeff',
      joinLink: 'https://ephera.test/index.html?roomId=room-qr-no-pass#roomJoinKey=00112233445566778899aabbccddeeff',
      passphrase: '   ',
    });
    assert(typeof payload === 'string' && payload.length > 0, 'FAIL: missing passphrase should still produce payload');
    const obj = JSON.parse(payload);
    assert(!Object.prototype.hasOwnProperty.call(obj, 'passphrase'), 'FAIL: empty passphrase should not be emitted');
  }

  console.log('--- INVITE QR PAYLOAD TEST PASSED ---');
}
