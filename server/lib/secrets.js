'use strict';
/**
 * Encrypts values kept in the database that would be dangerous if the file
 * leaked (the WooCommerce API keys). AES-256-GCM with a key derived from
 * APP_SECRET; format "v1.<iv>.<tag>.<ciphertext>" in base64url.
 */
const crypto = require('crypto');

function createSecrets(appSecret) {
  const key = crypto.createHash('sha256').update('anbar:secrets:' + appSecret).digest();
  return {
    encrypt(plain) {
      if (plain === null || plain === undefined || plain === '') return null;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(value) {
      if (!value) return null;
      const [v, iv, tag, ct] = String(value).split('.');
      if (v !== 'v1') throw new Error('unknown secret format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    }
  };
}

module.exports = { createSecrets };
