// An exact interpreter for make.fun's tiny stack ISA (see the kit's
// generator/subject/ISA.md): one run answers a whole set, running each
// <id>/program.bin on <id>/input.bin and writing its bytes and exit code
// (a trap's code included) to <output>/<id>/stdout.bin and exit.txt.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-opcode tables: immediate bytes, pops, pushes; -1 immediate = no opcode.
const IMM = new Int8Array(256).fill(-1);
const POPN = new Int8Array(256);
const PSHN = new Int8Array(256);
const T = (b: number, i: number, p: number, q: number) => { IMM[b] = i; POPN[b] = p; PSHN[b] = q; };
T(0x00, 0, 0, 0); T(0x01, 1, 0, 1); T(0x02, 4, 0, 1); T(0x03, 0, 1, 0);
T(0x04, 0, 1, 2); T(0x05, 0, 2, 2); T(0x06, 0, 2, 3); T(0x07, 0, 3, 3);
for (let b = 0x10; b <= 0x22; b++) T(b, 0, 2, 1); // the binary operators
T(0x17, 0, 1, 1); T(0x1b, 0, 1, 1); // NEG and NOT
T(0x30, 2, 0, 0); T(0x31, 2, 1, 0); T(0x32, 2, 1, 0); T(0x33, 2, 0, 0);
T(0x34, 0, 0, 0); T(0x40, 0, 1, 1); T(0x41, 0, 2, 0); T(0x50, 0, 1, 0);
T(0x51, 0, 1, 0); T(0x52, 0, 0, 1); T(0x53, 0, 1, 0);

// Runs one program to its end.
function run(P: Uint8Array, inp: Uint8Array) {
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const buf = new Uint8Array(65536);
  let sp = 0, csp = 0, pc = 0, ip = 0, olen = 0, steps = 0;
  const done = (code: number) => ({ out: buf.slice(0, olen), code });
  for (;;) {
    if (steps === 1000000) return done(10);
    if (pc < 0 || pc >= P.length) return done(9);
    const op = P[pc];
    const imm = IMM[op];
    if (imm < 0) return done(5);
    if (pc + imm >= P.length) return done(9);
    steps++;
    if (sp < POPN[op]) return done(2);
    if (sp - POPN[op] + PSHN[op] > 256) return done(3);
    pc += 1 + imm;
    switch (op) {
      case 0x00: // HALT
        return done(0);
      case 0x01: // PUSH8, sign-extended
        D[sp++] = (P[pc - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32, little-endian
        D[sp++] = P[pc - 4] | (P[pc - 3] << 8) | (P[pc - 2] << 16) | (P[pc - 1] << 24);
        break;
      case 0x03: // POP
        sp--;
        break;
      case 0x04: // DUP
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05: { // SWAP
        const t = D[sp - 1];
        D[sp - 1] = D[sp - 2];
        D[sp - 2] = t;
        break;
      }
      case 0x06: // OVER
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: { // ROT: ( a b c -- b c a )
        const a = D[sp - 3];
        D[sp - 3] = D[sp - 2];
        D[sp - 2] = D[sp - 1];
        D[sp - 1] = a;
        break;
      }
      case 0x17: // NEG
        D[sp - 1] = -D[sp - 1];
        break;
      case 0x1b: // NOT
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x30: // JMP
      case 0x31: // JZ
      case 0x32: { // JNZ
        const rel = ((P[pc - 2] | (P[pc - 1] << 8)) << 16) >> 16;
        if (op === 0x30 || (op === 0x31) === (D[--sp] === 0)) pc += rel;
        break;
      }
      case 0x33: // CALL: the immediate is the absolute target address
        if (csp === 64) return done(7);
        C[csp++] = pc;
        pc = P[pc - 2] | (P[pc - 1] << 8);
        break;
      case 0x34: // RET
        if (csp === 0) return done(8);
        pc = C[--csp];
        break;
      case 0x40: { // LOAD
        const a = D[sp - 1];
        if (a < 0 || a > 255) return done(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE: ( v addr -- )
        const a = D[sp - 1];
        if (a < 0 || a > 255) return done(6);
        M[a] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: { // PRINT
        const s = String(D[sp - 1]);
        if (olen + s.length > 65536) return done(11);
        sp--;
        for (let k = 0; k < s.length; k++) buf[olen++] = s.charCodeAt(k);
        break;
      }
      case 0x51: // PUTC
        if (olen === 65536) return done(11);
        buf[olen++] = D[--sp] & 255;
        break;
      case 0x52: // IN: -1 once the input is used up
        D[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53: // EXIT
        return done(D[sp - 1] & 255);
      default: { // the binary operators ADD..LTU (0x10..0x22): ( a b -- r )
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r: number;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b); // MUL: the exact low 32 bits
        else if (op === 0x13) { if (b === 0) return done(4); r = (a / b) | 0; }
        else if (op === 0x14) { if (b === 0) return done(4); r = b === -1 ? 0 : a % b; }
        else if (op === 0x15) { if (b === 0) return done(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; }
        else if (op === 0x16) { if (b === 0) return done(4); r = (a >>> 0) % (b >>> 0); }
        else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp--;
        D[sp - 1] = r;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(readFileSync(join(I, id, 'program.bin')), readFileSync(join(I, id, 'input.bin')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), r.code + '\n');
}
