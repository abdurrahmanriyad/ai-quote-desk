/**
 * Checks an upload before anything else touches it. Uploads come from outside,
 * so the file's own bytes decide its type, not the name it arrived with.
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class IntakeError extends Error {}

const startsWith = (bytes: Buffer, signature: number[]) =>
  signature.every((byte, index) => bytes[index] === byte);

const SIGNATURES = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
  // xlsx is a zip container.
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [0x50, 0x4b, 0x03, 0x04],
} as const;

const BINARY_BY_EXTENSION: Record<string, keyof typeof SIGNATURES> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const TEXT_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  eml: 'message/rfc822',
  csv: 'text/csv',
};

function isText(bytes: Buffer) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function detectMediaType(filename: string, bytes: Buffer): string {
  if (bytes.length === 0) throw new IntakeError('The file is empty');
  if (bytes.length > MAX_FILE_BYTES) throw new IntakeError('The file is larger than 20 MB');

  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const binary = BINARY_BY_EXTENSION[extension];
  if (binary) {
    if (!startsWith(bytes, [...SIGNATURES[binary]])) {
      throw new IntakeError(`${filename} does not match its file type`);
    }
    return binary;
  }

  const text = TEXT_BY_EXTENSION[extension];
  if (text) {
    if (!isText(bytes)) throw new IntakeError(`${filename} is not a text file`);
    return text;
  }

  throw new IntakeError(`Unsupported file type: .${extension}`);
}

/** Keeps a display name only. Storage keys never come from this value. */
export function safeDisplayName(filename: string) {
  const name = filename.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'upload';
}
