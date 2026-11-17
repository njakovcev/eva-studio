import { parse, type Font } from 'opentype.js';
import { textOutlines } from '../core/text';
import montserrat from '@fontsource/montserrat/files/montserrat-latin-700-normal.woff?url';
import montserratExt from '@fontsource/montserrat/files/montserrat-latin-ext-700-normal.woff?url';
import oswald from '@fontsource/oswald/files/oswald-latin-600-normal.woff?url';
import oswaldExt from '@fontsource/oswald/files/oswald-latin-ext-600-normal.woff?url';
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';
import pacificoExt from '@fontsource/pacifico/files/pacifico-latin-ext-400-normal.woff?url';

/** Fonts that come with the app (open licence), each as basic + extended Latin. */
export const FONTS: { id: string; name: string; files: string[] }[] = [
  { id: 'montserrat', name: 'Montserrat Bold', files: [montserrat, montserratExt] },
  { id: 'oswald', name: 'Oswald (narrow)', files: [oswald, oswaldExt] },
  { id: 'pacifico', name: 'Pacifico (script)', files: [pacifico, pacificoExt] },
];

const loaded = new Map<string, Promise<Font[]>>();

function load(id: string): Promise<Font[]> {
  const def = FONTS.find((f) => f.id === id) ?? FONTS[0];
  let p = loaded.get(def.id);
  if (!p) {
    p = Promise.all(def.files.map(async (url) => parse(await (await fetch(url)).arrayBuffer())));
    loaded.set(def.id, p);
    p.catch(() => loaded.delete(def.id));
  }
  return p;
}

/** Letter outlines for a line of text in one of the app's fonts. */
export async function textArtwork(content: string, fontId: string) {
  const out = textOutlines(content, await load(fontId));
  if (!out.rings.length) throw new Error('There is nothing to draw: type some text first.');
  return out;
}
