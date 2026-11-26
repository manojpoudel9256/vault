// OPTIONAL. Off by default. For SEARCH, Gemini only ever receives the question plus entry LABELS
// (service name, type, tags and optionally a masked account). Secret values, notes and
// history are never sent. Gemini answers with reference numbers; the app shows the secret locally.
import type { Entry, SecretType } from './vault';
import { cat, typeFor, type Category } from './categories';
import EXTRACT from './extract-prompt.json';

export function maskAccount(account: string): string {
  const at = account.indexOf('@');
  if (at > 0) return account[0] + '•••@' + account.slice(at + 1);
  if (account.length <= 3) return '•••';
  return account.slice(0, 2) + '•••' + account.slice(-2);
}

// ---------- Screenshot import (only when the user picks an image and confirms) ----------
// Unlike search, this DOES send the picked image to Google, because the image itself contains
// the secrets. The Import screen says so before anything is sent.

export interface ImageDraft {
  category: Category;
  service: string;
  account: string;
  type: SecretType;
  secret: string;
  notes: string;
  tags: string[];
  confidence: 'high' | 'low';
}

const CATS: Category[] = ['login', 'bank', 'card', 'id', 'phone', 'address', 'wifi', 'note'];

/** Shrinks the picture (max 1600 px, JPEG) so the upload is small. Re-encoding also drops photo metadata such as location. */
export async function prepareImage(file: File): Promise<{ base64: string; dataUrl: string }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl };
}

export async function extractFromImage(base64: string, opts: { apiKey: string; model: string }, signal?: AbortSignal): Promise<ImageDraft[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: EXTRACT.system.join('\n') }] },
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64 } }, { text: EXTRACT.user }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              entries: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    category: { type: 'STRING', enum: CATS },
                    service: { type: 'STRING' },
                    account: { type: 'STRING' },
                    type: { type: 'STRING', enum: ['password', 'pin', 'number', 'text'] },
                    secret: { type: 'STRING' },
                    notes: { type: 'STRING' },
                    tags: { type: 'ARRAY', items: { type: 'STRING' } },
                    confidence: { type: 'STRING', enum: ['high', 'low'] },
                  },
                  required: ['category', 'service', 'type', 'secret'],
                },
              },
            },
            required: ['entries'],
          },
        },
      }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
    },
  );
  if (!res.ok) throw new Error(res.status === 400 || res.status === 403 ? 'key' : `Gemini error ${res.status}`);
  const json = await res.json();
  const text: string = json?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') || '{"entries":[]}';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[] = JSON.parse(text).entries ?? [];
  return raw
    .filter((e) => e && typeof e.secret === 'string' && e.secret.trim() && CATS.includes(e.category))
    .map((e) => {
      const category = e.category as Category;
      return {
        category,
        service: String(e.service ?? '').trim() || cat(category).label,
        account: String(e.account ?? '').trim(),
        type: typeFor(category, e.type),
        secret: String(e.secret),
        notes: String(e.notes ?? '').trim(),
        tags: Array.isArray(e.tags) ? e.tags.map(String).filter(Boolean).slice(0, 4) : [],
        confidence: e.confidence === 'low' ? 'low' : 'high',
      } satisfies ImageDraft;
    });
}

export async function geminiMatch(
  question: string,
  entries: Entry[],
  opts: { apiKey: string; model: string; shareAccounts: boolean },
  signal?: AbortSignal,
): Promise<Entry[]> {
  const catalog = entries.map((e, i) => ({
    ref: String(i + 1),
    service: e.service,
    account: opts.shareAccounts ? e.account : maskAccount(e.account),
    type: e.type,
    tags: e.tags,
  }));
  const prompt =
    'You are the search helper inside a private password manager. You never see any secret values.\n' +
    'From the catalog below, return the refs of the entries the user is asking about, best match first.\n' +
    'If the question is ambiguous (for example several accounts for the same service), return every plausible ref.\n' +
    'Understand synonyms, abbreviations, typos and other languages. If nothing fits, return an empty list.\n\n' +
    'Catalog (JSON):\n' + JSON.stringify(catalog) + '\n\nQuestion: ' + question;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { refs: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['refs'] },
        },
      }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
    },
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const json = await res.json();
  const text: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"refs":[]}';
  const refs: string[] = JSON.parse(text).refs ?? [];
  return refs.map((r) => entries[Number(r) - 1]).filter((e): e is Entry => !!e);
}
