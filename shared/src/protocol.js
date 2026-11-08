// Version of the whole wire protocol (JSON control messages and both codecs).
export const PROTOCOL_VERSION = 1;

// Frame kinds of the binary codec (first byte of every binary frame).
export const MSG = { INPUT: 1, SNAPSHOT: 2 };

export const CODEC_NAMES = ["binary", "json"];

// Control messages are always JSON text, whatever the codec is:
//   client -> server: join, chat, ping, netsim
//   server -> client: welcome, roster, chat, pong, event, netsim
// Game messages (input up, snapshot down) go through the codec.
