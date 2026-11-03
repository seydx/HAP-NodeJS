import { Buffer } from 'node:buffer'
import crypto, { KeyObject } from 'node:crypto'

const OID_COMMON_NAME = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03])
// 1.2.840.10045.4.3.2
const OID_ECDSA_WITH_SHA256 = Buffer.from([
  0x06,
  0x08,
  0x2A,
  0x86,
  0x48,
  0xCE,
  0x3D,
  0x04,
  0x03,
  0x02,
])

/**
 * @group Camera Secure Video
 */
export interface CameraClientCSRValue {
  csr: Buffer
  nonceSignature: Buffer
}

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length])
  }
  const bytes: number[] = []
  for (let value = length; value > 0; value >>= 8) {
    bytes.unshift(value & 0xFF)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  return Buffer.concat([
    Buffer.from([tag]),
    derLength(body.length),
    body,
  ])
}

/**
 * @group Camera Secure Video
 */
export function generateClientKey(): KeyObject {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
}

/**
 * Builds a PKCS#10 certificate signing request for the given EC key and signs the controller nonce with the same key
 * (ECDSA-SHA256, r and s concatenated).
 *
 * @group Camera Secure Video
 */
export function createClientCSR(privateKey: KeyObject, commonName: string, nonce: Buffer): CameraClientCSRValue {
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })

  const subject = der(0x30, der(0x31, der(0x30, OID_COMMON_NAME, der(0x0C, Buffer.from(commonName, 'utf8')))))
  const info = der(0x30, der(0x02, Buffer.from([0x00])), subject, publicKey, der(0xA0))

  const signature = crypto.sign('sha256', info, privateKey)
  const csr = der(0x30, info, der(0x30, OID_ECDSA_WITH_SHA256), der(0x03, Buffer.from([0x00]), signature))

  return {
    csr,
    // raw r and s, the hub rejects DER encoded signatures
    nonceSignature: crypto.sign('sha256', nonce, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  }
}
