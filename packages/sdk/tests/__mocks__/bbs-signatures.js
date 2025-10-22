// Minimal mock for @digitalbazaar/bbs-signatures used in tests
const toHex = (u8) => Buffer.from(u8).toString('hex');

exports.sign = async ({ secretKey, publicKey, header, messages }) => {
  // produce a deterministic pseudo-signature for tests
  const data = [secretKey, publicKey, header, ...messages].map(toHex).join('|');
  return new Uint8Array(Buffer.from('sig:' + data));
};

exports.verifySignature = async ({ publicKey, signature, header, messages }) => {
  const expected = await exports.sign({ secretKey: new Uint8Array(0), publicKey, header, messages });
  // accept any signature that starts with 'sig:' and contains publicKey/header/messages
  const sigStr = Buffer.from(signature).toString();
  const expStr = Buffer.from(expected).toString();
  return sigStr.includes(Buffer.from(publicKey).toString('hex')) && sigStr.includes(Buffer.from(header).toString('hex')) && sigStr.includes(expStr.split('|').slice(2).join('|'));
};

