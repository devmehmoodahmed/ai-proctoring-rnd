// Builds the fake-camera / fake-microphone inputs for tests/e2e.mjs into
// tests/fixtures/ (gitignored). Run once: `node tests/make-fixtures.mjs`.
//
// Video: standard Xiph "derf" test sequences (CIF 352×288, 30 fps, 10 s loops):
//   akiyo           — one person, frontal, still: the happy path
//   mother_daughter — two people: MULTIPLE_FACES
//   foreman         — a face, then the camera pans away: FACE_MISSING
//   akiyo_dark      — akiyo with luma scaled to 25%: TOO_DARK (generated here)
// Audio (macOS only, uses `say` + `afconvert`): silence, then one spoken sentence,
// then silence; Chrome loops the file. English, Arabic (voice "Majed") and pure silence.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
mkdirSync(DIR, { recursive: true });
const XIPH = "https://media.xiph.org/video/derf/y4m/";
const RATE = 48000;

async function download(name) {
  const out = path.join(DIR, name);
  if (existsSync(out)) return out;
  console.log(`downloading ${name}…`);
  const res = await fetch(XIPH + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

// y4m: one text header line, then per frame "FRAME…\n" + Y plane + U + V (4:2:0).
function darken(src, dst, factor) {
  if (existsSync(dst)) return;
  const buf = readFileSync(src);
  const headerEnd = buf.indexOf(0x0a);
  const header = buf.subarray(0, headerEnd).toString();
  const w = Number(/ W(\d+)/.exec(header)[1]);
  const h = Number(/ H(\d+)/.exec(header)[1]);
  const ySize = w * h;
  const frameSize = ySize * 1.5;
  let pos = headerEnd + 1;
  while (pos < buf.length) {
    pos = buf.indexOf(0x0a, pos) + 1; // skip "FRAME…\n"
    for (let i = pos; i < pos + ySize; i++) buf[i] = Math.round(buf[i] * factor);
    pos += frameSize;
  }
  writeFileSync(dst, buf);
}

// Minimal 16-bit mono PCM WAV helpers.
function wavData(file) {
  const b = readFileSync(file);
  let p = 12;
  while (p < b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "data") return b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

function writeWav(file, pcm) {
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write("WAVEfmt ", 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); // PCM
  hdr.writeUInt16LE(1, 22); // mono
  hdr.writeUInt32LE(RATE, 24);
  hdr.writeUInt32LE(RATE * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([hdr, pcm]));
}

const silence = (s) => Buffer.alloc(Math.round(s * RATE) * 2);

function speech(name, voice, text, { leadS, tailS }) {
  const out = path.join(DIR, `${name}.wav`);
  if (existsSync(out)) return;
  const aiff = path.join(DIR, `${name}.aiff`);
  const raw = path.join(DIR, `${name}.raw.wav`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", aiff, raw]);
  const spoken = wavData(raw);
  // Repeat the sentence so the spoken part is comfortably above the 800 ms minimum.
  writeWav(out, Buffer.concat([silence(leadS), spoken, silence(0.3), spoken, silence(tailS)]));
  rmSync(aiff);
  rmSync(raw);
  console.log(`${name}.wav: ${leadS}s silence + speech (${((2 * spoken.length) / 2 / RATE).toFixed(1)}s) + ${tailS}s silence`);
}

for (const f of ["akiyo_cif.y4m", "mother_daughter_cif.y4m", "foreman_cif.y4m"]) await download(f);
darken(path.join(DIR, "akiyo_cif.y4m"), path.join(DIR, "akiyo_dark.y4m"), 0.25);

// Lead silence has to cover model loading + the 5 s quiet phase (see e2e.mjs).
speech("speech_en", "Samantha", "I am ready to start my practice exam.", { leadS: 14, tailS: 12 });
speech("speech_ar", "Majed", "أبدأ الآن الاختبار التدريبي.", { leadS: 14, tailS: 12 });
const silentOut = path.join(DIR, "silence.wav");
if (!existsSync(silentOut)) writeWav(silentOut, silence(60));
console.log(`fixtures ready in ${DIR}`);
