import { parseInvitePackageText } from '../invite-package.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runInvitePackageParsingTest() {
  console.log('--- STARTING INVITE PACKAGE PARSING TEST ---');

  {
    const key = 'abcdef0123456789abcdef0123456789';
    const pkg = [
      'Ephera Invite Package',
      'Room ID: room-alpha',
      `Room Auth Key: ${key}`,
      'Join Link: https://example.test/index.html?roomId=room-alpha#roomJoinKey=abcdef0123456789abcdef0123456789',
      'Passphrase: s3cur3-pass',
    ].join('\n');

    const out = parseInvitePackageText(pkg);
    assert(out.ok === true, 'FAIL: full package should parse');
    assert(out.roomId === 'room-alpha', 'FAIL: roomId mismatch');
    assert(out.roomJoinKey === key, 'FAIL: roomJoinKey mismatch');
    assert(out.passphraseSeen === true, 'FAIL: passphraseSeen should be true');
    assert(out.passphrase === 's3cur3-pass', 'FAIL: passphrase mismatch');
  }

  {
    const key = '1234567890abcdef1234567890abcdef';
    const json = JSON.stringify({
      room_id: 'room-json',
      room_auth_key: key,
      passphrase: '(not set - plain mode)',
    });
    const out = parseInvitePackageText(json);
    assert(out.ok === true, 'FAIL: JSON package should parse');
    assert(out.source === 'json', 'FAIL: source should be json');
    assert(out.roomId === 'room-json', 'FAIL: JSON roomId mismatch');
    assert(out.roomJoinKey === key, 'FAIL: JSON roomJoinKey mismatch');
    assert(out.passphraseSeen === true, 'FAIL: JSON passphraseSeen should be true');
    assert(out.passphrase === '', 'FAIL: plain-mode placeholder should normalize to empty passphrase');
  }

  {
    const key = 'fedcba9876543210fedcba9876543210';
    const link = `https://host.test/index.html?roomId=room-link&autojoin=1#roomJoinKey=${key}&passphrase=pp-123`;
    const out = parseInvitePackageText(link);
    assert(out.ok === true, 'FAIL: raw join link should parse');
    assert(out.source === 'link', 'FAIL: source should be link for raw URL input');
    assert(out.roomId === 'room-link', 'FAIL: link roomId mismatch');
    assert(out.roomJoinKey === key, 'FAIL: link roomJoinKey mismatch');
    assert(out.passphraseSeen === true, 'FAIL: link passphraseSeen should be true');
    assert(out.passphrase === 'pp-123', 'FAIL: link passphrase mismatch');
  }

  {
    // Compatibility path: legacy secret-bearing query params.
    const key = '00112233445566778899aabbccddeeff';
    const link = `https://legacy.test/?roomId=legacy-room&joinKey=${key}&passphrase=legacy-pass`;
    const out = parseInvitePackageText(link);
    assert(out.ok === true, 'FAIL: legacy query link should parse');
    assert(out.roomId === 'legacy-room', 'FAIL: legacy roomId mismatch');
    assert(out.roomJoinKey === key, 'FAIL: legacy joinKey mismatch');
    assert(out.passphrase === 'legacy-pass', 'FAIL: legacy passphrase mismatch');
  }

  {
    const out = parseInvitePackageText('   ');
    assert(out.ok === false, 'FAIL: empty package must fail');
    assert(String(out.reason).toLowerCase().includes('empty'), 'FAIL: empty package reason mismatch');
  }

  {
    const out = parseInvitePackageText('Room Auth Key: abcdef0123456789abcdef0123456789');
    assert(out.ok === false, 'FAIL: missing room id must fail');
    assert(String(out.reason).toLowerCase().includes('room id'), 'FAIL: missing room id reason mismatch');
  }

  {
    const out = parseInvitePackageText('Room ID: bad-room\nRoom Auth Key: not@valid');
    assert(out.ok === false, 'FAIL: invalid room key must fail');
    assert(String(out.reason).toLowerCase().includes('room auth key'), 'FAIL: invalid room key reason mismatch');
  }

  {
    const key = 'abcdefabcdefabcdefabcdefabcdefab';
    const out = parseInvitePackageText(`Room ID: no-pass\nRoom Auth Key: ${key}`);
    assert(out.ok === true, 'FAIL: package without passphrase should still parse');
    assert(out.passphraseSeen === false, 'FAIL: passphraseSeen should be false when missing');
    assert(out.passphrase === '', 'FAIL: missing passphrase should normalize to empty');
  }

  console.log('--- INVITE PACKAGE PARSING TEST PASSED ---');
}
