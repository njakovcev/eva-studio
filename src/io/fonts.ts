import { parse, type Font } from 'opentype.js';
import { textOutlines } from '../core/text';
import nunito from '@fontsource/nunito/files/nunito-latin-800-normal.woff?url';
import nunitoExt from '@fontsource/nunito/files/nunito-latin-ext-800-normal.woff?url';
import mplus from '@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-800-normal.woff?url';
import mplusExt from '@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-ext-800-normal.woff?url';
import quicksand from '@fontsource/quicksand/files/quicksand-latin-700-normal.woff?url';
import quicksandExt from '@fontsource/quicksand/files/quicksand-latin-ext-700-normal.woff?url';
import dosis from '@fontsource/dosis/files/dosis-latin-700-normal.woff?url';
import dosisExt from '@fontsource/dosis/files/dosis-latin-ext-700-normal.woff?url';
import comfortaa from '@fontsource/comfortaa/files/comfortaa-latin-700-normal.woff?url';
import comfortaaExt from '@fontsource/comfortaa/files/comfortaa-latin-ext-700-normal.woff?url';
import varela from '@fontsource/varela-round/files/varela-round-latin-400-normal.woff?url';
import varelaExt from '@fontsource/varela-round/files/varela-round-latin-ext-400-normal.woff?url';
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';
import pacificoExt from '@fontsource/pacifico/files/pacifico-latin-ext-400-normal.woff?url';
import montserrat from '@fontsource/montserrat/files/montserrat-latin-700-normal.woff?url';
import montserratExt from '@fontsource/montserrat/files/montserrat-latin-ext-700-normal.woff?url';
import oswald from '@fontsource/oswald/files/oswald-latin-600-normal.woff?url';
import oswaldExt from '@fontsource/oswald/files/oswald-latin-ext-600-normal.woff?url';

/**
 * Fonts that come with the app (open licence), each as basic + extended Latin.
 * Only fonts with rounded corners and ends are offered: a round cutter cannot make sharp
 * outside corners, so with these the milled letters look as drawn (checked 17. 11. with
 * T11 and T12 on capital letters 60 mm tall). Every one has Č Ć Đ Š Ž.
 */
export const FONTS: { id: string; name: string; files: string[] }[] = [
  { id: 'nunito', name: 'Nunito ExtraBold', files: [nunito, nunitoExt] },
  { id: 'mplus-rounded', name: 'M PLUS Rounded ExtraBold', files: [mplus, mplusExt] },
  { id: 'quicksand', name: 'Quicksand Bold', files: [quicksand, quicksandExt] },
  { id: 'dosis', name: 'Dosis Bold (narrow)', files: [dosis, dosisExt] },
  { id: 'comfortaa', name: 'Comfortaa Bold (geometric)', files: [comfortaa, comfortaaExt] },
  { id: 'varela-round', name: 'Varela Round (light)', files: [varela, varelaExt] },
  { id: 'pacifico', name: 'Pacifico (script)', files: [pacifico, pacificoExt] },
];
export const DEFAULT_FONT = 'nunito';

/** Fonts no longer offered (sharp corners), still readable so texts made with them can be edited. */
const RETIRED: { id: string; name: string; files: string[] }[] = [
  { id: 'montserrat', name: 'Montserrat Bold (sharp corners, no longer offered)', files: [montserrat, montserratExt] },
  { id: 'oswald', name: 'Oswald (sharp corners, no longer offered)', files: [oswald, oswaldExt] },
];
export const retiredFont = (id: string) => RETIRED.find((f) => f.id === id);

const loaded = new Map<string, Promise<Font[]>>();

function load(id: string): Promise<Font[]> {
  const def = FONTS.find((f) => f.id === id) ?? retiredFont(id) ?? FONTS[0];
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
