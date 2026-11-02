import { describe, expect, it } from 'vitest';
import { detectMediaType, IntakeError, MAX_FILE_BYTES, safeDisplayName } from './files.js';

const pdf = Buffer.from('%PDF-1.7 sample');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('detectMediaType', () => {
  it('accepts supported files whose content matches', () => {
    expect(detectMediaType('spec.PDF', pdf)).toBe('application/pdf');
    expect(detectMediaType('photo.png', png)).toBe('image/png');
    expect(detectMediaType('request.txt', Buffer.from('Please quote'))).toBe('text/plain');
    expect(detectMediaType('parts.csv', Buffer.from('a,b\n1,2'))).toBe('text/csv');
  });

  it('rejects a file that lies about its type', () => {
    expect(() => detectMediaType('invoice.pdf', Buffer.from('<script>'))).toThrow(IntakeError);
    expect(() => detectMediaType('notes.txt', png)).toThrow(IntakeError);
  });

  it('rejects empty, oversized and unsupported files', () => {
    expect(() => detectMediaType('a.txt', Buffer.alloc(0))).toThrow('empty');
    expect(() => detectMediaType('a.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 97))).toThrow('20 MB');
    expect(() => detectMediaType('run.exe', Buffer.from('MZ'))).toThrow('Unsupported');
  });
});

describe('safeDisplayName', () => {
  it('drops paths and control characters', () => {
    expect(safeDisplayName('../../etc/passwd')).toBe('passwd');
    expect(safeDisplayName('C:\\temp\\spec.pdf')).toBe('spec.pdf');
    expect(safeDisplayName('a\u0000b\n.txt')).toBe('ab.txt');
  });

  it('never returns an empty name', () => {
    expect(safeDisplayName('../')).toBe('upload');
  });
});
