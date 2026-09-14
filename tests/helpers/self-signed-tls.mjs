import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign
} from "node:crypto";

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) {
    bytes.unshift(remaining & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, ...parts) {
  const value = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function sequence(...parts) {
  return der(0x30, ...parts);
}

function integer(value) {
  let bytes = Buffer.from(value);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) {
    bytes = bytes.subarray(1);
  }
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function objectIdentifier(identifier) {
  const arcs = identifier.split(".").map(Number);
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const encoded = [arc & 0x7f];
    for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
      encoded.unshift((remaining & 0x7f) | 0x80);
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date) {
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return der(0x17, Buffer.from(`${year}${month}${day}${hour}${minute}${second}Z`, "ascii"));
}

function extension(identifier, value, critical = false) {
  return sequence(
    objectIdentifier(identifier),
    ...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
    der(0x04, value)
  );
}

function toPem(label, bytes) {
  const encoded = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----\n`;
}

/**
 * Creates a short-lived localhost certificate for HTTPS transport tests.
 * No private key material is stored in the repository or written to disk.
 */
export function createSelfSignedTlsFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const signatureAlgorithm = sequence(objectIdentifier("1.2.840.10045.4.3.2"));
  const commonName = sequence(
    der(0x31, sequence(
      objectIdentifier("2.5.4.3"),
      der(0x0c, Buffer.from("localhost", "utf8"))
    ))
  );
  const now = Date.now();
  const subjectAltName = sequence(
    der(0x82, Buffer.from("localhost", "ascii")),
    der(0x87, Buffer.from([127, 0, 0, 1]))
  );
  const extensions = sequence(
    extension("2.5.29.19", sequence(der(0x01, Buffer.from([0xff]))), true),
    extension("2.5.29.17", subjectAltName),
    extension("2.5.29.37", sequence(objectIdentifier("1.3.6.1.5.5.7.3.1")))
  );
  const tbsCertificate = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    signatureAlgorithm,
    commonName,
    sequence(
      utcTime(new Date(now - 5 * 60 * 1000)),
      utcTime(new Date(now + 24 * 60 * 60 * 1000))
    ),
    commonName,
    publicKey.export({ format: "der", type: "spki" }),
    der(0xa3, extensions)
  );
  const certificateBytes = sequence(
    tbsCertificate,
    signatureAlgorithm,
    der(0x03, Buffer.from([0]), sign("sha256", tbsCertificate, privateKey))
  );

  return {
    key: privateKey.export({ format: "pem", type: "pkcs8" }),
    certificate: toPem("CERTIFICATE", certificateBytes),
    fingerprint: createHash("sha256").update(certificateBytes).digest("hex")
  };
}
