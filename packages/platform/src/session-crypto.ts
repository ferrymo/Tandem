import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/** Credentials are opaque outside the composition root; AAD binds them to identity. */
export function createSessionCodec(keyHex: string) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex))
    throw new Error('会话加密密钥须为 32 字节十六进制值');
  const key = Buffer.from(keyHex, 'hex');
  return {
    token: () => randomBytes(32).toString('base64url'),
    hash: (token: string) => createHash('sha256').update(token).digest('hex'),
    seal(value: string, context: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url'),
      ].join('.');
    },
    open(value: string, context: string) {
      const [version, iv, tag, encrypted, extra] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !encrypted || extra !== undefined)
        throw new Error('无效的凭证密文');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
