import * as binary from "./binary.js";
import * as json from "./json.js";

const codecs = { binary, json };

export function getCodec(name) {
  const codec = codecs[name];
  if (!codec) throw new Error(`unknown codec "${name}"`);
  return codec;
}
