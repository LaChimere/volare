export const VOLARE_API_KEY_ENV = 'VOLARE_API_KEY';

export function generateVolareApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isValidVolareApiKey(value: string): boolean {
  return value.trim().length >= 16 && !/\s/.test(value);
}
